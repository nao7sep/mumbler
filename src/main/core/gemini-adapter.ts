import { readFile, stat } from "node:fs/promises";

import { ApiError, GoogleGenAI, type GenerateContentResponse } from "@google/genai";

import { type AppLogger } from "./logger";

const INLINE_REQUEST_LIMIT_BYTES = 20 * 1024 * 1024;
const INLINE_AUDIO_SAFETY_LIMIT_BYTES = 18 * 1024 * 1024;

/**
 * Dynamic thinking — the model decides how much to reason. Stated rather than left
 * to the provider's default, because the default is not one behaviour: measured
 * across the seeded list, gemini-3.5-flash / 3.1-pro-preview / 3-flash-preview all
 * think unasked while gemini-3.1-flash-lite does not. Silence shipped four
 * behaviours nobody chose; this ships one.
 *
 * Transcription itself is barely affected — it is dictation, not reasoning, and the
 * models agree: on dynamic, flash-lite spends 0 thinking tokens transcribing but 734
 * on an arithmetic question. So this is not "make transcription think", it is "stop
 * letting the provider decide per model". The value is consistency; the cost is a
 * few hundred tokens on the models that opt in.
 *
 * `-1` and not `0`: dynamic is accepted by every callable model tested (the seeded
 * four plus 2.5-flash/2.5-pro/flash-latest/pro-latest), so it stays safe for the
 * free-text ids this editable list invites. Disabling is NOT portable —
 * gemini-3.1-pro-preview rejects it outright ("Budget 0 is invalid. This model only
 * works in thinking mode"). That is why there is no thinking toggle: offering one
 * would require knowing each model's limits, i.e. a closed list, and the model
 * choice already IS the speed/quality choice.
 */
const THINKING_CONFIG = { thinkingBudget: -1 } as const;

export interface GeminiAudioTranscriptionParams {
  apiKey: string;
  filePath: string;
  mimeType: string;
  model: string;
  timeoutMs: number;
  signal?: AbortSignal;
  logger?: AppLogger;
}

export interface GeminiTextGenerationParams {
  apiKey: string;
  prompt: string;
  model: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface GeminiRunResult {
  text: string;
  modelVersion: string | null;
  usageMetadata: unknown;
  transport: "inline" | "files-api";
}

export class GeminiTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Gemini request timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    this.name = "GeminiTimeoutError";
  }
}

export class GeminiCancelledError extends Error {
  constructor() {
    super("AI work cancelled by user.");
    this.name = "GeminiCancelledError";
  }
}

export async function transcribeWithGemini(
  params: GeminiAudioTranscriptionParams,
): Promise<GeminiRunResult> {
  const ai = new GoogleGenAI({ apiKey: params.apiKey });
  const abortState = createGeminiAbortState(params.timeoutMs, params.signal);
  let uploadedFileName: string | null = null;
  let transport: GeminiRunResult["transport"] = "inline";

  try {
    throwIfExternallyCancelled(params.signal);
    const fileStats = await stat(params.filePath);
    const prompt = buildTranscriptionPrompt();

    let response: GenerateContentResponse;
    if (fileStats.size <= INLINE_AUDIO_SAFETY_LIMIT_BYTES) {
      const inlineData = await readFile(params.filePath, { encoding: "base64" });
      throwIfExternallyCancelled(params.signal);
      response = await ai.models.generateContent({
        model: params.model,
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType: params.mimeType,
                  data: inlineData,
                },
              },
            ],
          },
        ],
        config: {
          abortSignal: abortState.signal,
          thinkingConfig: THINKING_CONFIG,
        },
      });
    } else {
      transport = "files-api";
      throwIfExternallyCancelled(params.signal);
      const uploadedFile = await ai.files.upload({
        file: params.filePath,
        config: {
          mimeType: params.mimeType,
          abortSignal: abortState.signal,
        },
      });
      uploadedFileName = uploadedFile.name ?? null;
      await params.logger?.debug("gemini.upload", "Uploaded audio via Files API.", {
        uploadedFileName,
        fileUri: uploadedFile.uri,
        mimeType: uploadedFile.mimeType ?? params.mimeType,
      });

      response = await ai.models.generateContent({
        model: params.model,
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              {
                fileData: {
                  fileUri: uploadedFile.uri,
                  mimeType: uploadedFile.mimeType ?? params.mimeType,
                },
              },
            ],
          },
        ],
        config: {
          abortSignal: abortState.signal,
          thinkingConfig: THINKING_CONFIG,
        },
      });
    }

    const text = normalizeResponseText(response.text);
    return {
      text,
      modelVersion: response.modelVersion ?? null,
      usageMetadata: response.usageMetadata ?? null,
      transport,
    };
  } catch (error: unknown) {
    throw normalizeGeminiAbortError(error, abortState, params.timeoutMs);
  } finally {
    abortState.cleanup();
    if (uploadedFileName !== null) {
      try {
        await ai.files.delete({ name: uploadedFileName });
      } catch (cleanupError: unknown) {
        await params.logger?.warn(
          "gemini.upload-cleanup",
          "Failed to delete uploaded file from Files API.",
          {
            uploadedFileName,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          },
        );
      }
    }
  }
}

export async function generateTextWithGemini(
  params: GeminiTextGenerationParams,
): Promise<Omit<GeminiRunResult, "transport">> {
  const ai = new GoogleGenAI({ apiKey: params.apiKey });
  const abortState = createGeminiAbortState(params.timeoutMs, params.signal);

  try {
    throwIfExternallyCancelled(params.signal);
    const response = await ai.models.generateContent({
      model: params.model,
      contents: [
        {
          role: "user",
          parts: [{ text: params.prompt }],
        },
      ],
      config: {
        abortSignal: abortState.signal,
        thinkingConfig: THINKING_CONFIG,
      },
    });

    return {
      text: normalizeResponseText(response.text),
      modelVersion: response.modelVersion ?? null,
      usageMetadata: response.usageMetadata ?? null,
    };
  } catch (error: unknown) {
    throw normalizeGeminiAbortError(error, abortState, params.timeoutMs);
  } finally {
    abortState.cleanup();
  }
}

export function isRetryableGeminiError(error: unknown): boolean {
  if (error instanceof GeminiTimeoutError || error instanceof GeminiCancelledError) {
    return false;
  }

  if (error instanceof ApiError) {
    return error.status === 429 || error.status >= 500;
  }

  if (error instanceof Error) {
    return /network|fetch|stream/i.test(error.message);
  }

  return false;
}

export function isGeminiCancelledError(error: unknown): boolean {
  return error instanceof GeminiCancelledError;
}

export function getInlineAudioSafetyLimitBytes(): number {
  return INLINE_AUDIO_SAFETY_LIMIT_BYTES;
}

export function getInlineRequestLimitBytes(): number {
  return INLINE_REQUEST_LIMIT_BYTES;
}

function buildTranscriptionPrompt(): string {
  return [
    "Generate a faithful transcript of the spoken audio.",
    "Return only the transcript text.",
    "Do not add summaries, timestamps, headings, speaker labels, markdown, or explanations.",
  ].join(" ");
}

function normalizeResponseText(value: string | undefined): string {
  const normalized = value?.trim() ?? "";
  if (normalized.length === 0) {
    throw new Error("Gemini returned an empty text response.");
  }

  return normalized;
}

interface GeminiAbortState {
  signal: AbortSignal;
  timedOut: () => boolean;
  externallyCancelled: () => boolean;
  cleanup: () => void;
}

function createGeminiAbortState(
  timeoutMs: number,
  externalSignal: AbortSignal | undefined,
): GeminiAbortState {
  const controller = new AbortController();
  let didTimeOut = false;
  let didExternalCancel = false;
  const timeoutId = setTimeout(() => {
    didTimeOut = true;
    controller.abort();
  }, timeoutMs);

  const onExternalAbort = (): void => {
    didExternalCancel = true;
    controller.abort();
  };

  if (externalSignal?.aborted) {
    onExternalAbort();
  } else {
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  }

  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    externallyCancelled: () => didExternalCancel,
    cleanup: () => {
      clearTimeout(timeoutId);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    },
  };
}

function throwIfExternallyCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new GeminiCancelledError();
  }
}

function normalizeGeminiAbortError(
  error: unknown,
  abortState: GeminiAbortState,
  timeoutMs: number,
): unknown {
  if (error instanceof GeminiTimeoutError || error instanceof GeminiCancelledError) {
    return error;
  }

  if (isAbortError(error)) {
    if (abortState.externallyCancelled()) {
      return new GeminiCancelledError();
    }

    if (abortState.timedOut()) {
      return new GeminiTimeoutError(timeoutMs);
    }
  }

  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
