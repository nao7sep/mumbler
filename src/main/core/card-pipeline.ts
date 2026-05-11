import { stat } from "node:fs/promises";

import type {
  AppPaths,
  CardProcessingStep,
  MumblerCard,
  MumblerSettings,
  MumblerState,
} from "@shared/app-shell";

import type { AppLogger } from "./logger";
import {
  analyzeTrimDecision,
  prepareAudioForTranscription,
} from "./audio-tools";
import {
  generateTextWithGemini,
  getInlineAudioSafetyLimitBytes,
  getInlineRequestLimitBytes,
  isRetryableGeminiError,
  transcribeWithGemini,
} from "./gemini-adapter";
import { decodeGeminiApiKey } from "./settings-schema";

export interface CardPipelineContext {
  state: MumblerState;
  settings: MumblerSettings;
  paths: AppPaths;
  logger: AppLogger;
  activeCardOperations: Set<string>;
  persistState: () => Promise<void>;
  onTranscriptionSlotReleased: () => Promise<void>;
}

export async function executeCardPipeline(
  cardId: string,
  mode: "transcribe" | "retry",
  ctx: CardPipelineContext,
): Promise<void> {
  const state = ctx.state;
  const settings = ctx.settings;
  const logger = ctx.logger;
  const card = state.cards.find((entry) => entry.id === cardId);

  if (card === undefined) {
    throw new Error("Card to process does not exist.");
  }

  const startStep = resolvePipelineStartStep(card, mode);
  await logger.info("pipeline.start", "Starting card pipeline.", {
    cardId,
    mode,
    startStep,
  });
  let activeStep: Exclude<CardProcessingStep, null> = startStep;
  let holdsTranscriptionSlot = false;

  card.queuedMode = null;
  card.queuedAtUtc = null;

  try {
    const apiKey = decodeGeminiApiKey(settings.geminiApiKeyObfuscated);
    if (apiKey.length === 0) {
      throw new Error("Gemini API key is not configured.");
    }

    if (startStep === "transcription") {
      ctx.activeCardOperations.add(cardId);
      holdsTranscriptionSlot = true;

      clearCardResults(card);
      await setCardStepState(card, "Transcribing", "transcription", ctx);

      const trimDecision =
        card.trimDecision ??
        (await analyzeTrimDecision(card.sourceFilePath, card.trim, card.durationSec));
      card.trimDecision = trimDecision;
      card.updatedAtUtc = Date.now();
      await ctx.persistState();

      const preparedAudio = await prepareAudioForTranscription({
        sourceFilePath: card.sourceFilePath,
        workingDir: ctx.paths.workingDir,
        trim: card.trim,
        trimDecision,
        durationSec: card.durationSec,
        audioProfile: card.audioProfile,
        logger,
      });

      try {
        await logger.info("pipeline.audio-input", "Prepared audio for Gemini transcription.", {
          cardId,
          transportCandidate:
            (await stat(preparedAudio.filePath)).size <= getInlineAudioSafetyLimitBytes()
              ? "inline"
              : "files-api",
          inlineSafetyLimitBytes: getInlineAudioSafetyLimitBytes(),
          inlineRequestLimitBytes: getInlineRequestLimitBytes(),
          sourceFilePath: card.sourceFilePath,
          preparedFilePath: preparedAudio.filePath,
          preparedMimeType: preparedAudio.mimeType,
          wasDerived: preparedAudio.wasDerived,
          trimDecision: trimDecision.kind,
        });

        const transcriptionResult = await executeWithRetry({
          cardId,
          step: "transcription",
          op: "gemini.transcription",
          execute: () =>
            transcribeWithGemini({
              apiKey,
              filePath: preparedAudio.filePath,
              mimeType: preparedAudio.mimeType,
              model: settings.transcriptionModel,
              timeoutMs: settings.timeouts.transcriptionMs,
              logger,
            }),
        }, ctx);

        card.transcription.text = transcriptionResult.text;
        card.ai.transcription = {
          provider: "gemini",
          model: transcriptionResult.modelVersion ?? settings.transcriptionModel,
          generatedAtUtc: Date.now(),
        };
        card.updatedAtUtc = Date.now();

        await logger.info("pipeline.transcription-complete", "Completed Gemini transcription.", {
          cardId,
          modelVersion: transcriptionResult.modelVersion,
          transport: transcriptionResult.transport,
          usageMetadata: transcriptionResult.usageMetadata,
        });
      } finally {
        await preparedAudio.cleanup();
      }

      ctx.activeCardOperations.delete(cardId);
      holdsTranscriptionSlot = false;
      await ctx.onTranscriptionSlotReleased();

      activeStep = "structured";
    }

    if (activeStep === "structured") {
      await setCardStepState(card, "Generating Metadata", "structured", ctx);
      const structuredPrompt = renderPromptTemplate(settings.prompts.structured, {
        transcript: card.transcription.text ?? "",
        structured: "",
        title: "",
      });
      const structuredResult = await executeWithRetry({
        cardId,
        step: "structured",
        op: "gemini.structured",
        execute: () =>
          generateTextWithGemini({
            apiKey,
            prompt: structuredPrompt,
            model: settings.metadataModel,
            timeoutMs: settings.timeouts.structuredMs,
          }),
      }, ctx);

      card.metadata.structured = structuredResult.text.trim();
      card.ai.structured = {
        provider: "gemini",
        model: structuredResult.modelVersion ?? settings.metadataModel,
        generatedAtUtc: Date.now(),
      };
      card.updatedAtUtc = Date.now();
      await ctx.persistState();
      await logger.info("pipeline.structured-complete", "Generated structured outline.", {
        cardId,
        modelVersion: structuredResult.modelVersion,
        usageMetadata: structuredResult.usageMetadata,
      });

      activeStep = "title";
    }

    if (activeStep === "title") {
      await setCardStepState(card, "Generating Metadata", "title", ctx);
      const titlePrompt = renderPromptTemplate(settings.prompts.title, {
        transcript: card.transcription.text ?? "",
        structured: card.metadata.structured ?? "",
        title: "",
      });
      const titleResult = await executeWithRetry({
        cardId,
        step: "title",
        op: "gemini.title",
        execute: () =>
          generateTextWithGemini({
            apiKey,
            prompt: titlePrompt,
            model: settings.metadataModel,
            timeoutMs: settings.timeouts.titleMs,
          }),
      }, ctx);

      card.metadata.title = sanitizeTitle(titleResult.text);
      card.ai.title = {
        provider: "gemini",
        model: titleResult.modelVersion ?? settings.metadataModel,
        generatedAtUtc: Date.now(),
      };
      card.updatedAtUtc = Date.now();
      await ctx.persistState();
      await logger.info("pipeline.title-complete", "Generated title metadata.", {
        cardId,
        modelVersion: titleResult.modelVersion,
        usageMetadata: titleResult.usageMetadata,
      });

      activeStep = "slug";
    }

    if (activeStep === "slug") {
      await setCardStepState(card, "Generating Metadata", "slug", ctx);
      const slugPrompt = renderPromptTemplate(settings.prompts.slug, {
        transcript: card.transcription.text ?? "",
        structured: card.metadata.structured ?? "",
        title: card.metadata.title ?? "",
      });
      const slugResult = await executeWithRetry({
        cardId,
        step: "slug",
        op: "gemini.slug",
        execute: () =>
          generateTextWithGemini({
            apiKey,
            prompt: slugPrompt,
            model: settings.metadataModel,
            timeoutMs: settings.timeouts.slugMs,
          }),
      }, ctx);

      card.metadata.slug = sanitizeSlug(slugResult.text);
      if (card.metadata.slug.length === 0) {
        throw new Error("Generated slug was empty after sanitization.");
      }
      card.ai.slug = {
        provider: "gemini",
        model: slugResult.modelVersion ?? settings.metadataModel,
        generatedAtUtc: Date.now(),
      };
      card.status = "Ready to Save";
      card.activeStep = null;
      card.lastError = null;
      card.updatedAtUtc = Date.now();

      await ctx.persistState();
      await logger.info("pipeline.slug-complete", "Generated slug metadata.", {
        cardId,
        modelVersion: slugResult.modelVersion,
        usageMetadata: slugResult.usageMetadata,
      });
    }
  } catch (error: unknown) {
    card.status = "Error";
    card.activeStep = null;
    card.queuedMode = null;
    card.queuedAtUtc = null;
    card.lastError = {
      message: getCardErrorMessage(error),
      occurredAtUtc: Date.now(),
      failedStep: activeStep,
    };
    card.updatedAtUtc = Date.now();

    await ctx.persistState();
    await logger.error("pipeline.failed", "Card pipeline failed.", error, {
      cardId,
      failedStep: activeStep,
      status: card.status,
    });
  } finally {
    if (holdsTranscriptionSlot) {
      ctx.activeCardOperations.delete(cardId);
      try {
        await ctx.onTranscriptionSlotReleased();
      } catch (drainError: unknown) {
        await logger.warn("pipeline.drain-failed", "Failed to drain queued cards after slot release.", {
          cardId,
          error: drainError instanceof Error ? drainError.message : String(drainError),
        });
      }
    }
  }
}

async function setCardStepState(
  card: MumblerCard,
  status: Extract<MumblerCard["status"], "Transcribing" | "Generating Metadata">,
  step: Exclude<CardProcessingStep, null>,
  ctx: CardPipelineContext,
): Promise<void> {
  card.status = status;
  card.activeStep = step;
  card.lastError = null;
  card.updatedAtUtc = Date.now();
  await ctx.persistState();
}

async function executeWithRetry<T>(params: {
  cardId: string;
  step: Exclude<CardProcessingStep, null>;
  op: string;
  execute: () => Promise<T>;
}, ctx: CardPipelineContext): Promise<T> {
  const { retryPolicy } = ctx.settings;
  const logger = ctx.logger;

  let attempt = 1;
  while (true) {
    try {
      return await params.execute();
    } catch (error: unknown) {
      const retryable = isRetryableGeminiError(error);
      const exhausted = attempt >= retryPolicy.maxRetries;

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
      await sleep(delayMs);
      attempt += 1;
    }
  }
}

export function clearCardResults(card: MumblerCard): void {
  card.transcription = { text: null };
  card.metadata = { structured: null, title: null, slug: null };
  card.ai = { transcription: null, structured: null, title: null, slug: null };
  card.status = "Imported";
  card.activeStep = null;
  card.queuedMode = null;
  card.queuedAtUtc = null;
  card.lastError = null;
  card.updatedAtUtc = Date.now();
}

export function resolvePipelineStartStep(
  card: MumblerCard,
  mode: "transcribe" | "retry",
): Exclude<CardProcessingStep, null> {
  if (mode === "transcribe") {
    return "transcription";
  }

  if (card.lastError?.failedStep === "structured" && card.transcription.text !== null) {
    return "structured";
  }

  if (card.lastError?.failedStep === "title" && card.transcription.text !== null) {
    return "title";
  }

  if (
    card.lastError?.failedStep === "slug" &&
    card.transcription.text !== null &&
    card.metadata.title !== null
  ) {
    return "slug";
  }

  return "transcription";
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

function sanitizeTitle(value: string): string {
  return value
    .replaceAll(/\*\*/g, "")
    .replaceAll(/\*/g, "")
    .replace(/^\s*["'`]+|["'`]+\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeSlug(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[`"'""'']/g, "")
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .slice(0, 80);
}

function getCardErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown processing failure.";
}

// Uses 4^n (not 2^n) for aggressive backoff suited to Gemini API rate limits,
// which penalize rapid retries more heavily than typical HTTP services.
function computeRetryDelayMs(
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

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
