import { stat } from "node:fs/promises";

import type {
  AppPaths,
  CardProcessingStep,
  MumblerCard,
  MumblerSettings,
  MumblerQueue,
} from "@shared/app-shell";
import { thinkingFor } from "@shared/ai-models";

import type { AppLogger } from "./logger";
import {
  analyzeTrimDecision,
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
  state: MumblerQueue;
  settings: MumblerSettings;
  paths: AppPaths;
  logger: AppLogger;
  signal: AbortSignal;
  // The resolved Gemini API key for this run. The runtime resolves it
  // environment-first from the dedicated secrets store before spawning the
  // pipeline, so the pipeline itself does no secret I/O and the key never flows
  // through the settings object.
  apiKey: string;
  persistState: () => Promise<void>;
  // Releases the transcription concurrency slot this run holds, then admits any
  // queued cards into the freed capacity. A no-op when the run never acquired a
  // slot (e.g. a metadata-only regeneration), and idempotent so it can be called
  // both when transcription finishes and again on the way out.
  releaseTranscriptionSlot: () => Promise<void>;
  // Whether this run still owns its card: a cancel or a newer run takes it
  // away. Only the owner writes to the card, and only an owner not cancelled
  // applies a result.
  ownsCard: () => boolean;
}

export type PipelineMode = "generate";
export type PipelineStartStep = Exclude<CardProcessingStep, null>;

export async function executeCardPipeline(
  cardId: string,
  startStep: PipelineStartStep,
  mode: PipelineMode,
  ctx: CardPipelineContext,
): Promise<void> {
  const state = ctx.state;
  const settings = ctx.settings;
  const logger = ctx.logger;
  const started = state.cards.find((entry) => entry.id === cardId);
  if (started === undefined) {
    throw new Error("Card to process does not exist.");
  }
  // The card as it is now, for this run to read or write: looked up by id each
  // time, because a cancel replaces the card object, and refused once the run no
  // longer owns it or was cancelled, so a late provider result can never land in
  // the card a cancel or a newer run took over. Checked and written without an
  // await in between.
  const live = (): MumblerCard => {
    const current = state.cards.find((entry) => entry.id === cardId);
    if (current === undefined || !ctx.ownsCard()) throw new CancelledError();
    throwIfCancelled(ctx.signal);
    return current;
  };
  // What the run transcribes from, fixed when it starts, so a trim changed
  // mid-run never passes for the one the transcript was cut from.
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
  let activeStep: PipelineStartStep = startStep;

  started.queuedMode = null;
  started.queuedAtUtc = null;

  try {
    throwIfCancelled(ctx.signal);
    const apiKey = ctx.apiKey;
    if (apiKey.length === 0) {
      throw new Error("Gemini API key is not configured.");
    }

    if (startStep === "transcription") {
      const clearing = live();
      if (clearCardResultsFromStep(clearing, "transcription")) {
        clearing.updatedAtUtc = Date.now();
      }
      await setCardStepState(live, "Transcribing", "transcription", ctx);

      let trimDecision = runTrimDecision;
      if (trimDecision === null) {
        trimDecision = await analyzeTrimDecision(sourceFilePath, runTrim, durationSec, ctx.signal);
        runTrimDecision = trimDecision;
        live().trimDecision = { ...trimDecision };
        await ctx.persistState();
      }

      // The signal the Gemini call already honours now reaches the audio
      // stage too: it was the one await in this pipeline that ignored Cancel,
      // so a stop left ffmpeg running and the promise unsettled.
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
              timeoutMs: settings.timeouts.transcriptionMs,
              signal: ctx.signal,
              logger,
              recordCall,
            }),
        }, ctx);

        // The transcript is the largest stored body and was previously kept RAW.
        // Trim per-line trailing whitespace and drop edge blank lines, but keep
        // interior blank runs — they are deliberate paragraph breaks in speech.
        const transcribed = live();
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

        await logger.info("pipeline.transcription-complete", "Completed Gemini transcription.", {
          cardId,
          modelVersion: transcriptionResult.modelVersion,
          transport: transcriptionResult.transport,
          usage: transcriptionResult.usageMetadata,
        });
      } finally {
        await preparedAudio.cleanup();
      }

      // Release the concurrency slot the moment transcription is done so other
      // queued transcriptions can start while this card continues with metadata.
      await ctx.releaseTranscriptionSlot();

      activeStep = "structured";
    }

    if (activeStep === "structured") {
      const clearing = live();
      if (clearCardResultsFromStep(clearing, "structured")) {
        clearing.updatedAtUtc = Date.now();
      }
      await setCardStepState(live, "Generating Metadata", "structured", ctx);
      const structuredPrompt = renderPromptTemplate(settings.prompts.structured, {
        transcript: live().transcription.text ?? "",
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
            timeoutMs: settings.timeouts.transcriptionMs,
            signal: ctx.signal,
            recordCall,
          }),
      }, ctx);

      // Structured output is a multi-line Markdown outline. A scalar .trim() here
      // would eat the first content line's indentation and leave interior trailing
      // whitespace, so clean it as a multiline body instead.
      const outlined = live();
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
      await ctx.persistState();
      await logger.info("pipeline.structured-complete", "Generated structured outline.", {
        cardId,
        modelVersion: structuredResult.modelVersion,
        usage: structuredResult.usageMetadata,
      });

      activeStep = "title";
    }

    if (activeStep === "title") {
      const clearing = live();
      if (clearCardResultsFromStep(clearing, "title")) {
        clearing.updatedAtUtc = Date.now();
      }
      await setCardStepState(live, "Generating Metadata", "title", ctx);
      const titleInput = live();
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
            timeoutMs: settings.timeouts.metadataMs,
            signal: ctx.signal,
            recordCall,
          }),
      }, ctx);

      const titled = live();
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
      await ctx.persistState();
      await logger.info("pipeline.title-complete", "Generated title metadata.", {
        cardId,
        modelVersion: titleResult.modelVersion,
        usage: titleResult.usageMetadata,
      });

      activeStep = "slug";
    }

    if (activeStep === "slug") {
      const clearing = live();
      if (clearCardResultsFromStep(clearing, "slug")) {
        clearing.updatedAtUtc = Date.now();
      }
      await setCardStepState(live, "Generating Metadata", "slug", ctx);
      const slugInput = live();
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
            timeoutMs: settings.timeouts.metadataMs,
            signal: ctx.signal,
            recordCall,
          }),
      }, ctx);

      const slug = sanitizeSlug(slugResult.text);
      if (slug.length === 0) {
        throw new Error("Generated slug was empty after sanitization.");
      }
      const finished = live();
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

      await ctx.persistState();
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
    const card = state.cards.find((entry) => entry.id === cardId);
    if (card !== undefined && ctx.ownsCard()) {
      card.status = status;
      card.activeStep = null;
      card.queuedMode = null;
      card.queuedAtUtc = null;
      const providerReason = geminiProviderReason(error);
      card.lastError = wasCancelled ? null : {
        message: cardFailureMessage(activeStep),
        ...(providerReason ? { providerReason } : {}),
        ...(error instanceof GeminiResultError && error.refused ? { refused: true as const } : {}),
        occurredAtUtc: Date.now(),
        failedStep: activeStep,
      };
      await ctx.persistState();
    }
    await logPipelineFailure(logger, error, cardId, activeStep, status);
  } finally {
    // Always release on the way out. Idempotent: a no-op if transcription already
    // released the slot above; otherwise it frees the slot still held by a run
    // that failed or was cancelled before transcription completed.
    try {
      await ctx.releaseTranscriptionSlot();
    } catch (drainError: unknown) {
      await logger.warn("pipeline.drain-failed", "Failed to drain queued cards after slot release.", {
        cardId,
        error: drainError instanceof Error ? drainError.message : String(drainError),
      });
    }
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

async function setCardStepState(
  live: () => MumblerCard,
  status: Extract<MumblerCard["status"], "Transcribing" | "Generating Metadata">,
  step: Exclude<CardProcessingStep, null>,
  ctx: CardPipelineContext,
): Promise<void> {
  const card = live();
  card.status = status;
  card.activeStep = step;
  card.lastError = null;
  await ctx.persistState();
}

async function executeWithRetry<T>(params: {
  cardId: string;
  step: Exclude<CardProcessingStep, null>;
  op: string;
  execute: (recordCall: RecordProviderCall) => Promise<T>;
}, ctx: CardPipelineContext): Promise<T> {
  const { retryPolicy } = ctx.settings;
  const logger = ctx.logger;

  let attempt = 1;
  while (true) {
    throwIfCancelled(ctx.signal);
    try {
      const callAttempt = attempt;
      return await params.execute((call) =>
        logger.providerCall({ ...call, cardId: params.cardId, step: params.step, attempt: callAttempt }));
    } catch (error: unknown) {
      const retryable = isRetryableGeminiError(error);
      const exhausted = attempt > retryPolicy.maxRetries;

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

      const delayMs = computeRetryDelayMs(attempt, retryPolicy);
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

export function resolveGenerateStartStep(
  card: MumblerCard,
  target: PipelineStartStep,
): PipelineStartStep {
  return resolveEarliestRequiredStep(card, target);
}

function resolveEarliestRequiredStep(
  card: MumblerCard,
  target: PipelineStartStep,
): PipelineStartStep {
  if (target !== "transcription" && card.transcription.text === null) {
    return "transcription";
  }

  if ((target === "title" || target === "slug") && card.metadata.structured === null) {
    return "structured";
  }

  if (target === "slug" && card.metadata.title === null) {
    return "title";
  }

  return target;
}

function renderPromptTemplate(
  template: string,
  values: {
    transcript: string;
    structured: string;
    title: string;
  },
): string {
  return template
    .replaceAll("{transcript}", values.transcript)
    .replaceAll("{structured}", values.structured)
    .replaceAll("{title}", values.title);
}

export function sanitizeTitle(value: string): string {
  return value
    .replaceAll(/\*\*/g, "")
    .replaceAll(/\*/g, "")
    .replace(/^\s*["'`]+|["'`]+\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function sanitizeSlug(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[`"'""'']/g, "")
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .slice(0, 80);
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
export function computeRetryDelayMs(
  attempt: number,
  retryPolicy: MumblerSettings["retryPolicy"],
): number {
  const baseDelay = Math.min(
    retryPolicy.maxDelayMs,
    retryPolicy.initialDelayMs * 4 ** (attempt - 1),
  );
  const jitterWindow = Math.round(baseDelay * retryPolicy.jitterRatio);
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
