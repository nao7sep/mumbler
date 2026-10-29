import { stat } from "node:fs/promises";

import type {
  AppPaths,
  CardProcessingStep,
  MumblerCard,
  MumblerSettings,
} from "@shared/app-shell";
import { thinkingFor } from "@shared/ai-models";

import type { AppLogger } from "./logger";
import {
  analyzeTrimDecision,
  cleanupPreparedAudio,
  prepareAudioForTranscription,
} from "./audio-tools";
import {
  generateTextWithGemini,
  geminiProviderReason,
  GeminiResultError,
  INLINE_AUDIO_LIMIT_BYTES,
  isRetryableGeminiError,
  type RecordProviderCall,
  transcribeWithGemini,
} from "./gemini-adapter";
import { CancelledError, isCancelledError } from "./cancellation";
import { multiline } from "./text-cleanup";

export interface CardPipelineContext {
  settings: MumblerSettings;
  paths: AppPaths;
  logger: AppLogger;
  signal: AbortSignal;
  // The resolved Gemini API key for this run. The runtime resolves it
  // environment-first from the dedicated secrets store before the run starts,
  // so the pipeline itself does no secret I/O and the key never flows through
  // the settings object.
  apiKey: string;
  // The card as it is now, for reading; throws CancelledError once this run no
  // longer owns it (a cancel or a newer run took it) or was cancelled.
  current: () => MumblerCard;
  // Reports a result: the queue applies it to the card and saves it in its
  // turn, only while this run still owns the card and was not cancelled;
  // otherwise it throws CancelledError and nothing changes.
  update: (change: (card: MumblerCard) => void) => Promise<void>;
  // Reports how the run ended: applied while this run still owns the card,
  // even after cancellation, and dropped once another took it.
  settle: (change: (card: MumblerCard) => void) => Promise<void>;
  // Provider work that may outlive the run's cancellation; the run's place is
  // held until it settles.
  trackWork: (work: Promise<unknown>) => void;
}

export type PipelineMode = "generate";
export type PipelineStartStep = Exclude<CardProcessingStep, null>;

// The card's status while this run works on `step`, cleared of results from
// that step on.
function enterStep(card: MumblerCard, step: PipelineStartStep): void {
  if (clearCardResultsFromStep(card, step)) card.updatedAtUtc = Date.now();
  card.status = step === "transcription" ? "Transcribing" : "Generating Metadata";
  card.activeStep = step;
  card.queuedMode = null;
  card.queuedAtUtc = null;
  card.lastError = null;
}

export async function executeCardPipeline(
  cardId: string,
  startStep: PipelineStartStep,
  mode: PipelineMode,
  ctx: CardPipelineContext,
): Promise<void> {
  const settings = ctx.settings;
  const logger = ctx.logger;
  const apiKey = ctx.apiKey;
  let activeStep: PipelineStartStep = startStep;

  try {
    // What the run transcribes from, fixed when it starts, so a trim changed
    // mid-run never passes for the one the transcript was cut from.
    const started = ctx.current();
    const runTrim = { ...started.trim };
    let runTrimDecision = started.trimDecision === null ? null : { ...started.trimDecision };
    const sourceFilePath = started.sourceFilePath;
    const durationSec = started.durationSec;
    const audioProfile = started.audioProfile;

    await logger.info("pipeline.start", "Starting card pipeline.", {
      cardId,
      mode,
      startStep,
    });
    if (apiKey.length === 0) {
      throw new Error("Gemini API key is not configured.");
    }

    if (startStep === "transcription") {
      await ctx.update((card) => enterStep(card, "transcription"));

      let trimDecision = runTrimDecision;
      if (trimDecision === null) {
        const analyzed = await analyzeTrimDecision(sourceFilePath, runTrim, durationSec, ctx.signal);
        trimDecision = analyzed;
        runTrimDecision = analyzed;
        await ctx.update((card) => { card.trimDecision = { ...analyzed }; });
      }

      // The signal the Gemini call honours reaches the audio stage too, so a
      // stop also ends ffmpeg. Preparation runs inside the run's place: one
      // preparation keeps one core busy (measured: trimming and re-encoding an
      // hour of stereo audio to AAC or MP3 used CPU time about equal to its wall
      // time, on a ten-core Mac), so several side by side use otherwise idle cores.
      const preparedAudio = await prepareAudioForTranscription({
        sourceFilePath,
        workingDir: ctx.paths.workingDir,
        trim: runTrim,
        trimDecision,
        durationSec,
        audioProfile,
        logger,
        signal: ctx.signal,
      });

      try {
        await logger.info("pipeline.audio-input", "Prepared audio for Gemini transcription.", {
          cardId,
          transportCandidate:
            (await stat(preparedAudio.filePath)).size <= INLINE_AUDIO_LIMIT_BYTES
              ? "inline"
              : "files-api",
          inlineAudioLimitBytes: INLINE_AUDIO_LIMIT_BYTES,
          sourceFilePath,
          preparedFilePath: preparedAudio.filePath,
          preparedMimeType: preparedAudio.mimeType,
          wasDerived: preparedAudio.wasDerived,
          trimDecision: trimDecision.kind,
        });

        const transcriptionResult = await executeWithRetry({
          cardId,
          step: "transcription",
          op: "gemini.transcription",
          execute: (recordCall) =>
            transcribeWithGemini({
              apiKey,
              endpoint: settings["gemini.endpoint"],
              filePath: preparedAudio.filePath,
              mimeType: preparedAudio.mimeType,
              model: settings["gemini.transcription"],
              thinking: thinkingFor(settings["gemini.transcription"], settings["gemini.thinking.transcription"]),
              timeoutMs: TRANSCRIPTION_TIMEOUT_MS,
              signal: ctx.signal,
              logger,
              recordCall,
              trackWork: ctx.trackWork,
            }),
        }, ctx);

        // The transcript is the largest stored body and was previously kept RAW.
        // Trim per-line trailing whitespace and drop edge blank lines, but keep
        // interior blank runs — they are deliberate paragraph breaks in speech.
        await ctx.update((transcribed) => {
          transcribed.transcription = {
            text: multiline(transcriptionResult.text, {
              trimLineEnds: true,
              dropEdgeBlankLines: true,
              collapseBlankLines: false,
            }),
          };
          transcribed.ai = {
            ...transcribed.ai,
            transcription: {
              provider: "gemini",
              model: transcriptionResult.modelVersion ?? settings["gemini.transcription"],
              generatedAtUtc: Date.now(),
            },
          };
          transcribed.transcribedTrim = { ...runTrim };
          transcribed.updatedAtUtc = Date.now();
        });

        await logger.info("pipeline.transcription-complete", "Completed Gemini transcription.", {
          cardId,
          modelVersion: transcriptionResult.modelVersion,
          transport: transcriptionResult.transport,
          usage: transcriptionResult.usageMetadata,
        });
      } finally {
        await cleanupPreparedAudio(preparedAudio, logger);
      }

      activeStep = "structured";
    }

    if (activeStep === "structured") {
      await ctx.update((card) => enterStep(card, "structured"));
      const structuredPrompt = renderPromptTemplate(settings.prompts.structured, {
        transcript: ctx.current().transcription.text ?? "",
        structured: "",
        title: "",
      });
      const structuredResult = await executeWithRetry({
        cardId,
        step: "structured",
        op: "gemini.structured",
        execute: (recordCall) =>
          generateTextWithGemini({
            apiKey,
            endpoint: settings["gemini.endpoint"],
            prompt: structuredPrompt,
            model: settings["gemini.outline"],
            thinking: thinkingFor(settings["gemini.outline"], settings["gemini.thinking.outline"]),
            timeoutMs: TRANSCRIPTION_TIMEOUT_MS,
            signal: ctx.signal,
            recordCall,
          }),
      }, ctx);

      // Structured output is a multi-line Markdown outline. A scalar .trim() here
      // would eat the first content line's indentation and leave interior trailing
      // whitespace, so clean it as a multiline body instead.
      await ctx.update((outlined) => {
        outlined.metadata = {
          ...outlined.metadata,
          structured: multiline(structuredResult.text, {
            trimLineEnds: true,
            dropEdgeBlankLines: true,
            collapseBlankLines: false,
          }),
        };
        outlined.ai = {
          ...outlined.ai,
          structured: {
            provider: "gemini",
            model: structuredResult.modelVersion ?? settings["gemini.outline"],
            generatedAtUtc: Date.now(),
          },
        };
        outlined.updatedAtUtc = Date.now();
      });
      await logger.info("pipeline.structured-complete", "Generated structured outline.", {
        cardId,
        modelVersion: structuredResult.modelVersion,
        usage: structuredResult.usageMetadata,
      });

      activeStep = "title";
    }

    if (activeStep === "title") {
      await ctx.update((card) => enterStep(card, "title"));
      const titleInput = ctx.current();
      const titlePrompt = renderPromptTemplate(settings.prompts.title, {
        transcript: titleInput.transcription.text ?? "",
        structured: titleInput.metadata.structured ?? "",
        title: "",
      });
      const titleResult = await executeWithRetry({
        cardId,
        step: "title",
        op: "gemini.title",
        execute: (recordCall) =>
          generateTextWithGemini({
            apiKey,
            endpoint: settings["gemini.endpoint"],
            prompt: titlePrompt,
            field: "title",
            model: settings["gemini.metadata"],
            thinking: thinkingFor(settings["gemini.metadata"], settings["gemini.thinking.metadata"]),
            timeoutMs: METADATA_TIMEOUT_MS,
            signal: ctx.signal,
            recordCall,
          }),
      }, ctx);

      await ctx.update((titled) => {
        titled.metadata = { ...titled.metadata, title: sanitizeTitle(titleResult.text) };
        titled.ai = {
          ...titled.ai,
          title: {
            provider: "gemini",
            model: titleResult.modelVersion ?? settings["gemini.metadata"],
            generatedAtUtc: Date.now(),
          },
        };
        titled.updatedAtUtc = Date.now();
      });
      await logger.info("pipeline.title-complete", "Generated title metadata.", {
        cardId,
        modelVersion: titleResult.modelVersion,
        usage: titleResult.usageMetadata,
      });

      activeStep = "slug";
    }

    if (activeStep === "slug") {
      await ctx.update((card) => enterStep(card, "slug"));
      const slugInput = ctx.current();
      const slugPrompt = renderPromptTemplate(settings.prompts.slug, {
        transcript: slugInput.transcription.text ?? "",
        structured: slugInput.metadata.structured ?? "",
        title: slugInput.metadata.title ?? "",
      });
      const slugResult = await executeWithRetry({
        cardId,
        step: "slug",
        op: "gemini.slug",
        execute: (recordCall) =>
          generateTextWithGemini({
            apiKey,
            endpoint: settings["gemini.endpoint"],
            prompt: slugPrompt,
            field: "slug",
            model: settings["gemini.metadata"],
            thinking: thinkingFor(settings["gemini.metadata"], settings["gemini.thinking.metadata"]),
            timeoutMs: METADATA_TIMEOUT_MS,
            signal: ctx.signal,
            recordCall,
          }),
      }, ctx);

      const slug = sanitizeSlug(slugResult.text);
      if (slug.length === 0) {
        throw new Error("Generated slug was empty after sanitization.");
      }
      await ctx.update((finished) => {
        finished.metadata = { ...finished.metadata, slug };
        finished.ai = {
          ...finished.ai,
          slug: {
            provider: "gemini",
            model: slugResult.modelVersion ?? settings["gemini.metadata"],
            generatedAtUtc: Date.now(),
          },
        };
        finished.status = "Ready to Save";
        finished.activeStep = null;
        finished.lastError = null;
        finished.updatedAtUtc = Date.now();
      });
      await logger.info("pipeline.slug-complete", "Generated slug metadata.", {
        cardId,
        modelVersion: slugResult.modelVersion,
        usage: slugResult.usageMetadata,
      });
    }
  } catch (error: unknown) {
    const wasCancelled = isCancelledError(error);
    const status = wasCancelled ? "Cancelled" : "Error";
    // A run that lost its card leaves it to whatever took it over.
    await ctx.settle((card) => {
      card.status = status;
      card.activeStep = null;
      card.queuedMode = null;
      card.queuedAtUtc = null;
      const providerReason = geminiProviderReason(error, apiKey);
      card.lastError = wasCancelled ? null : {
        message: cardFailureMessage(activeStep),
        ...(providerReason ? { providerReason } : {}),
        ...(error instanceof GeminiResultError && error.refused ? { refused: true as const } : {}),
        occurredAtUtc: Date.now(),
        failedStep: activeStep,
      };
    });
    await logPipelineFailure(logger, error, cardId, activeStep, status);
  }
}

async function logPipelineFailure(
  logger: AppLogger,
  error: unknown,
  cardId: string,
  activeStep: PipelineStartStep,
  status: MumblerCard["status"],
): Promise<void> {
  if (isCancelledError(error)) {
    await logger.info("pipeline.cancelled", "Card pipeline cancelled.", {
      cardId,
      failedStep: activeStep,
      status,
    });
    return;
  }

  await logger.error("pipeline.failed", "Card pipeline failed.", error, {
    cardId,
    failedStep: activeStep,
    status,
  });
}

// How long one call may take: a transcription carries a whole recording and
// a long one takes minutes; an outline, title or slug is text in, text out.
export const TRANSCRIPTION_TIMEOUT_MS = 30 * 60 * 1000;
export const METADATA_TIMEOUT_MS = 5 * 60 * 1000;

// Gemini is asked at most three times for one step, and only after an answer
// it did not process (isRetryableGeminiError). The waits between grow fast,
// from about a second to at most 16, spread a little so several cards do not
// retry together.
export const GEMINI_ATTEMPTS = 3;
const RETRY_INITIAL_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 16_000;
const RETRY_JITTER_RATIO = 0.2;

async function executeWithRetry<T>(params: {
  cardId: string;
  step: Exclude<CardProcessingStep, null>;
  op: string;
  execute: (recordCall: RecordProviderCall) => Promise<T>;
}, ctx: CardPipelineContext): Promise<T> {
  const logger = ctx.logger;

  let attempt = 1;
  while (true) {
    throwIfCancelled(ctx.signal);
    try {
      const callAttempt = attempt;
      const execute = () => params.execute((call) =>
        logger.providerCall({ ...call, cardId: params.cardId, step: params.step, attempt: callAttempt }));
      return await execute();
    } catch (error: unknown) {
      const retryable = isRetryableGeminiError(error);
      const exhausted = attempt >= GEMINI_ATTEMPTS;

      await logger.warn(params.op, "Gemini step attempt failed.", {
        cardId: params.cardId,
        step: params.step,
        attempt,
        retryable,
        exhausted,
        error: error instanceof Error ? error.message : String(error),
      });

      if (!retryable || exhausted) {
        throw error;
      }

      const delayMs = computeRetryDelayMs(attempt);
      await logger.debug(params.op, "Retrying Gemini step after delay.", {
        cardId: params.cardId,
        step: params.step,
        nextAttempt: attempt + 1,
        delayMs,
      });
      await sleep(delayMs, ctx.signal);
      attempt += 1;
    }
  }
}

export function clearCardResults(card: MumblerCard): void {
  if (clearCardResultsFromStep(card, "transcription")) {
    card.updatedAtUtc = Date.now();
  }
  card.status = "Imported";
  card.activeStep = null;
  card.queuedMode = null;
  card.queuedAtUtc = null;
  card.lastError = null;
}

// Returns whether it cleared any content, which moves the card's modified time
// (content-lifecycle-conventions, "Modified").
export function clearCardResultsFromStep(
  card: MumblerCard,
  step: PipelineStartStep,
): boolean {
  // New objects rather than edits in place: a copy of the card made elsewhere
  // (a cancel's replacement, a snapshot) never sees this change.
  const before = JSON.stringify([card.transcription, card.metadata]);
  const metadata = { ...card.metadata };
  const ai = { ...card.ai };
  if (step === "transcription") {
    card.transcription = { text: null };
    ai.transcription = null;
    card.transcribedTrim = null;
  }

  if (step === "transcription" || step === "structured") {
    metadata.structured = null;
    ai.structured = null;
  }

  if (step === "transcription" || step === "structured" || step === "title") {
    metadata.title = null;
    ai.title = null;
  }

  metadata.slug = null;
  ai.slug = null;
  card.metadata = metadata;
  card.ai = ai;
  return JSON.stringify([card.transcription, card.metadata]) !== before;
}

export { resolveGenerateStartStep } from "@shared/generate-rules";

function renderPromptTemplate(
  template: string,
  values: {
    transcript: string;
    structured: string;
    title: string;
  },
): string {
  return template.replace(/\{(transcript|structured|title)\}/g, (_match, key: keyof typeof values) => values[key]);
}

export function sanitizeTitle(value: string): string {
  return value
    .replaceAll(/\*\*/g, "")
    .replaceAll(/\*/g, "")
    .replace(/^\s*["'`]+|["'`]+\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// The 80-character bound is part of a slug's format, like its alphabet: the slug
// names exported files and URLs, and the generated response it was cut from is
// kept whole in its provider-call record. Edge hyphens are trimmed after the
// cut so it never ends a slug.
export function sanitizeSlug(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[`"'""'']/g, "")
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/-+/g, "-")
    .slice(0, 80)
    .replaceAll(/^-|-$/g, "");
}

function cardFailureMessage(step: CardProcessingStep): string {
  switch (step) {
    case "transcription":
      return "The recording could not be transcribed. Check the audio tools and Gemini settings, then try again.";
    case "structured":
    case "title":
    case "slug":
      return "AI metadata could not be generated. Your recording is kept. Earlier generated results may have been cleared. Check the Gemini settings and try again.";
    case null:
      return "The recording could not be processed. Your recording is kept; try again.";
  }
}

// Uses 4^n (not 2^n) for aggressive backoff suited to Gemini API rate limits,
// which penalize rapid retries more heavily than typical HTTP services.
export function computeRetryDelayMs(attempt: number): number {
  const baseDelay = Math.min(RETRY_MAX_DELAY_MS, RETRY_INITIAL_DELAY_MS * 4 ** (attempt - 1));
  const jitterWindow = Math.round(baseDelay * RETRY_JITTER_RATIO);
  const jitterOffset =
    jitterWindow === 0 ? 0 : Math.round((Math.random() * jitterWindow * 2) - jitterWindow);
  return Math.max(0, baseDelay + jitterOffset);
}

function sleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new CancelledError());
      return;
    }

    const timeoutId = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);

    const onAbort = (): void => {
      clearTimeout(timeoutId);
      reject(new CancelledError());
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new CancelledError();
  }
}
