import { readFile, stat } from "node:fs/promises";

import { ApiError, type GenerateContentResponse } from "@google/genai";

import { GeminiClient, GeminiHttpError } from "./gemini-http";
import { generationPolicy } from "@shared/model-registry";
import type { AiRole } from "@shared/ai-models";

import { type AppLogger } from "./logger";
import { CancelledError } from "./cancellation";

const INLINE_REQUEST_LIMIT_BYTES = 20_000_000;
const INLINE_AUDIO_SAFETY_LIMIT_BYTES = INLINE_REQUEST_LIMIT_BYTES;
const FILES_API_CLEANUP_TIMEOUT_MS = 30_000;

export interface GeminiAudioTranscriptionParams {
  apiKey: string;
  endpoint?: string;
  filePath: string;
  mimeType: string;
  model: string;
  timeoutMs: number;
  signal?: AbortSignal;
  logger?: AppLogger;
}

export interface GeminiTextGenerationParams {
  apiKey: string;
  endpoint?: string;
  prompt: string;
  role?: Exclude<AiRole, "transcription">;
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

export class GeminiResultError extends Error {
  constructor(message: string, readonly providerMessage: string | null = null) { super(message); }
}

export function geminiProviderReason(error: unknown): string | null {
  if (error instanceof GeminiHttpError) return error.providerMessage;
  return error instanceof GeminiResultError ? error.providerMessage : null;
}

export class GeminiTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Gemini request timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    this.name = "GeminiTimeoutError";
  }
}

export async function transcribeWithGemini(
  params: GeminiAudioTranscriptionParams,
): Promise<GeminiRunResult> {
  const ai = new GeminiClient({ apiKey: params.apiKey, endpoint: params.endpoint });
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
      response = await ai.generateContent({
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
          ...generationPolicy(params.model, "transcription"),
        },
      });
    } else {
      transport = "files-api";
      throwIfExternallyCancelled(params.signal);
      const uploadedFile = await ai.upload({
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

      response = await ai.generateContent({
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
          ...generationPolicy(params.model, "transcription"),
        },
      });
    }

    const text = readResponseText(response);
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
      void deleteUploadedFile(ai, uploadedFileName, params.logger);
    }
  }
}

// Removing the upload is best-effort: Gemini expires uploads by itself. So the
// delete runs beside the result instead of in front of it, and its own bound
// ends it on a stalled connection rather than leaving it pending.
async function deleteUploadedFile(ai: GeminiClient, name: string, logger: AppLogger | undefined): Promise<void> {
  try {
    await ai.delete({
      name,
      config: {
        abortSignal: AbortSignal.timeout(FILES_API_CLEANUP_TIMEOUT_MS),
      },
    });
  } catch (cleanupError: unknown) {
    await logger?.warn(
      "gemini.upload-cleanup",
      "Failed to delete uploaded file from Files API.",
      {
        uploadedFileName: name,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      },
    );
  }
}

export async function generateTextWithGemini(
  params: GeminiTextGenerationParams,
): Promise<Omit<GeminiRunResult, "transport">> {
  const ai = new GeminiClient({ apiKey: params.apiKey, endpoint: params.endpoint });
  const abortState = createGeminiAbortState(params.timeoutMs, params.signal);

  try {
    throwIfExternallyCancelled(params.signal);
    const response = await ai.generateContent({
      model: params.model,
      contents: [
        {
          role: "user",
          parts: [{ text: params.prompt }],
        },
      ],
      config: {
        abortSignal: abortState.signal,
        ...generationPolicy(params.model, params.role ?? "metadata"),
      },
    });

    return {
      text: readResponseText(response),
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
  if (error instanceof GeminiTimeoutError || error instanceof CancelledError) {
    return false;
  }

  if (error instanceof ApiError || error instanceof GeminiHttpError) {
    return [408, 429, 503].includes(error.status);
  }

  const code = connectionCode(error);
  return code !== null && ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(code);
}

function connectionCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  if ("code" in error && typeof error.code === "string") return error.code;
  return "cause" in error ? connectionCode(error.cause) : null;
}

export function retryAfterDelayMs(error: unknown, now = Date.now()): number | null {
  const value = error instanceof GeminiHttpError ? error.retryAfter : null;
  if (!value) return null;
  const seconds = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : null;
  const delay = seconds === null ? Date.parse(value) - now : seconds * 1000;
  return Number.isFinite(delay) ? Math.min(30_000, Math.max(0, delay)) : null;
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

/**
 * The provider's own account of a result that is not what was asked for, read BEFORE the text
 * (ai-model-routing-conventions: *never invent a cause the provider gave you*). Both call sites
 * go through this rather than touching `response.text`, so the check cannot be forgotten at one
 * of them.
 *
 * Measured 2026-08-20: a 100-second recording came back with no text and
 * `promptFeedback.blockReason: "PROHIBITED_CONTENT"` — the audio was refused. Reading only
 * `.text` reported "Gemini returned an empty text response", which is not merely unhelpful:
 * it was believed, and produced a written finding that the model could not transcribe long
 * audio. A refusal is the user's to act on, and only the stated reason tells them so.
 *
 * MAX_TOKENS is the quieter half: the text is present and looks like a complete short answer.
 */
function readResponseText(response: GenerateContentResponse): string {
  const blockReason = response.promptFeedback?.blockReason;
  if (blockReason) {
    throw new GeminiResultError(
      `Gemini refused this request (${blockReason}). The input was rejected, not lost — try different audio or wording.`,
      response.promptFeedback?.blockReasonMessage ?? null,
    );
  }

  const finishReason = response.candidates?.[0]?.finishReason;
  const finishMessage = response.candidates?.[0]?.finishMessage ?? null;
  if (finishReason === "SAFETY" || finishReason === "PROHIBITED_CONTENT") {
    throw new GeminiResultError(`Gemini refused this request (${finishReason}). Try different audio or wording.`, finishMessage);
  }
  if (finishReason === "MAX_TOKENS") {
    throw new GeminiResultError("Gemini stopped at its output limit, so this result is truncated rather than complete.", finishMessage);
  }
  // Anything other than a normal stop is the provider telling us the result is not what was
  // asked for. Absent is fine — not every response carries one.
  if (finishReason && finishReason !== "STOP") {
    throw new GeminiResultError(`Gemini stopped early (${finishReason}), so this result is incomplete.`, finishMessage);
  }

  return normalizeResponseText(response.text);
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
    throw new CancelledError();
  }
}

function normalizeGeminiAbortError(
  error: unknown,
  abortState: GeminiAbortState,
  timeoutMs: number,
): unknown {
  if (error instanceof GeminiTimeoutError || error instanceof CancelledError) {
    return error;
  }

  if (isAbortError(error)) {
    if (abortState.externallyCancelled()) {
      return new CancelledError();
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
