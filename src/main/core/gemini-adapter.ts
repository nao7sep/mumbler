import { readFile, stat } from "node:fs/promises";

import {
  ApiError,
  GoogleGenAI,
  HarmBlockThreshold,
  HarmCategory,
  Type,
  type GenerateContentConfig,
  type GenerateContentResponse,
  type SafetySetting,
} from "@google/genai";

import { supportedModelConfig } from "@shared/model-branches";

import { type AppLogger, type ProviderCallRecord } from "./logger";
import { CancelledError } from "./cancellation";

// Inline audio travels as base64 (4 bytes per 3) in a request of at most 20,000,000 bytes that also carries the prompt.
export const INLINE_AUDIO_LIMIT_BYTES = ((20_000_000 - 1_000_000) * 3) / 4;
const FILES_API_CLEANUP_TIMEOUT_MS = 30_000;

// The most permissive safety values, sent on every generation and never exposed
// (ai-model-lineup-20261004, Safety).
const GEMINI_SAFETY_SETTINGS: readonly SafetySetting[] = [
  HarmCategory.HARM_CATEGORY_HARASSMENT,
  HarmCategory.HARM_CATEGORY_HATE_SPEECH,
  HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
  HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
  HarmCategory.HARM_CATEGORY_JAILBREAK,
].map((category) => ({ category, threshold: HarmBlockThreshold.OFF }));

// The plain request's config: what the feature asks for, the safety settings and,
// for a structured answer, a strict one-field schema; then the model's own branch,
// which adds only its thinking. An id with no branch gets this alone.
function generationConfig(model: string, thinking: string | undefined, field?: string): GenerateContentConfig {
  return {
    safetySettings: [...GEMINI_SAFETY_SETTINGS],
    ...(field === undefined
      ? {}
      : {
          responseMimeType: "application/json",
          responseSchema: { type: Type.OBJECT, properties: { [field]: { type: Type.STRING } }, required: [field] },
        }),
    ...supportedModelConfig(model, thinking),
  };
}

// The SDK's own retries would resend a request that may already have been billed,
// stacking on top of card-pipeline's retryPolicy. `attempts: 1` disables them so the
// pipeline is the only retry authority. The SDK's ApiError does not expose
// Retry-After, so the pipeline's own backoff spaces its retries. `timeout` is the
// same bound already used for the call's AbortSignal, not a second, shorter deadline.
// These options are set on the client: the Files API upload ignores an abort signal,
// so the client's timeout is what bounds each of its requests, and an upload given
// its own httpOptions loses the SDK's resumable-upload headers.
function singleAttemptHttpOptions(timeoutMs: number): { timeout: number; retryOptions: { attempts: number } } {
  return { timeout: timeoutMs, retryOptions: { attempts: 1 } };
}

// The pipeline binds the card, step and attempt; the adapter supplies the rest.
export type RecordProviderCall = (
  call: Omit<ProviderCallRecord, "cardId" | "step" | "attempt">,
) => Promise<void>;

export interface GeminiAudioTranscriptionParams {
  apiKey: string;
  endpoint?: string;
  filePath: string;
  mimeType: string;
  model: string;
  // The role's thinking value from thinkingFor; absent for a model with no row.
  thinking?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  logger?: AppLogger;
  recordCall?: RecordProviderCall;
}

export interface GeminiTextGenerationParams {
  apiKey: string;
  endpoint?: string;
  prompt: string;
  model: string;
  // The role's thinking value from thinkingFor; absent for a model with no row.
  thinking?: string;
  // The one field of a structured answer, such as a title, asked for with a strict
  // schema and returned alone; absent for prose, which comes back as plain text.
  field?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  recordCall?: RecordProviderCall;
}

export interface GeminiRunResult {
  text: string;
  modelVersion: string | null;
  usageMetadata: unknown;
  transport: "inline" | "files-api";
}

// `refused` marks the provider declining the input, which resending cannot change.
export class GeminiResultError extends Error {
  constructor(message: string, readonly providerMessage: string | null = null, readonly refused = false) { super(message); }
}

export function geminiProviderReason(error: unknown): string | null {
  if (error instanceof ApiError) return apiErrorProviderMessage(error);
  return error instanceof GeminiResultError ? error.providerMessage : null;
}

// The SDK's ApiError message is the response body as JSON. Gemini's error body is a
// google.rpc.Status: `message` is the provider's own account of the failure and
// `status` a canonical code name such as RESOURCE_EXHAUSTED. A body that is not JSON
// reaches the same shape with its raw text as `message` and the HTTP status text as
// `status`; that text is not the provider's message.
function apiErrorProviderMessage(error: ApiError): string | null {
  try {
    const { message, status } = JSON.parse(error.message)?.error ?? {};
    return typeof message === "string" && typeof status === "string" && /^[A-Z_]+$/.test(status) ? message : null;
  } catch {
    return null;
  }
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
  const ai = new GoogleGenAI({
    apiKey: params.apiKey,
    httpOptions: { baseUrl: params.endpoint, ...singleAttemptHttpOptions(params.timeoutMs) },
  });
  const record = callRecorder(params);
  const abortState = createGeminiAbortState(params.timeoutMs, params.signal);
  let uploadedFileName: string | null = null;
  let transport: GeminiRunResult["transport"] = "inline";

  try {
    throwIfExternallyCancelled(params.signal);
    const fileStats = await stat(params.filePath);
    const prompt = buildTranscriptionPrompt();
    const config = generationConfig(params.model, params.thinking);

    let response: GenerateContentResponse;
    if (fileStats.size <= INLINE_AUDIO_LIMIT_BYTES) {
      const inlineData = await readFile(params.filePath, { encoding: "base64" });
      throwIfExternallyCancelled(params.signal);
      const request = {
        model: params.model,
        contents: [
          { role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: params.mimeType, data: inlineData } }] },
        ],
        config,
      };
      // The audio bytes stay in their file; the record names that file instead.
      const recordedRequest = {
        ...request,
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              { inlineData: { mimeType: params.mimeType, filePath: params.filePath, byteSize: fileStats.size } },
            ],
          },
        ],
      };
      response = await record("models.generateContent", params.model, recordedRequest, () =>
        ai.models.generateContent({ ...request, config: { abortSignal: abortState.signal, ...config } }),
      );
    } else {
      transport = "files-api";
      throwIfExternallyCancelled(params.signal);
      const upload = { file: params.filePath, config: { mimeType: params.mimeType } };
      const uploadedFile = await record("files.upload", null, upload, () => ai.files.upload(upload));
      uploadedFileName = uploadedFile.name ?? null;

      const request = {
        model: params.model,
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              { fileData: { fileUri: uploadedFile.uri, mimeType: uploadedFile.mimeType ?? params.mimeType } },
            ],
          },
        ],
        config,
      };
      response = await record("models.generateContent", params.model, request, () =>
        ai.models.generateContent({ ...request, config: { abortSignal: abortState.signal, ...config } }),
      );
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
      void deleteUploadedFile(ai, uploadedFileName, record, params.logger);
    }
  }
}

type CallRecorder = <T>(operation: string, model: string | null, request: unknown, call: () => Promise<T>) => Promise<T>;

// Wraps one SDK call so its request, its answer or failure, and its timing are
// recorded (data-lifecycle-conventions, Records).
function callRecorder(params: { endpoint?: string; recordCall?: RecordProviderCall }): CallRecorder {
  return async (operation, model, request, call) => {
    const startedAt = new Date().toISOString();
    const write = (response: unknown, error: unknown): Promise<void> =>
      params.recordCall?.({
        provider: "gemini",
        operation,
        endpoint: params.endpoint ?? null,
        model,
        startedAt,
        finishedAt: new Date().toISOString(),
        request,
        response,
        error,
      }) ?? Promise.resolve();
    let response: Awaited<ReturnType<typeof call>>;
    try {
      response = await call();
    } catch (error: unknown) {
      await write(null, error);
      throw error;
    }
    await write(response, null);
    return response;
  };
}

// Removing the upload is best-effort: Gemini expires uploads by itself. So the
// delete runs beside the result instead of in front of it, and its own bound
// ends it on a stalled connection rather than leaving it pending.
async function deleteUploadedFile(
  ai: GoogleGenAI,
  name: string,
  record: CallRecorder,
  logger: AppLogger | undefined,
): Promise<void> {
  const httpOptions = singleAttemptHttpOptions(FILES_API_CLEANUP_TIMEOUT_MS);
  try {
    await record("files.delete", null, { name, config: { httpOptions } }, () =>
      ai.files.delete({
        name,
        config: { abortSignal: AbortSignal.timeout(FILES_API_CLEANUP_TIMEOUT_MS), httpOptions },
      }),
    );
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
  const ai = new GoogleGenAI({
    apiKey: params.apiKey,
    httpOptions: { baseUrl: params.endpoint, ...singleAttemptHttpOptions(params.timeoutMs) },
  });
  const record = callRecorder(params);
  const abortState = createGeminiAbortState(params.timeoutMs, params.signal);

  try {
    throwIfExternallyCancelled(params.signal);
    const config = generationConfig(params.model, params.thinking, params.field);
    const request = {
      model: params.model,
      contents: [{ role: "user", parts: [{ text: params.prompt }] }],
      config,
    };
    const response = await record("models.generateContent", params.model, request, () =>
      ai.models.generateContent({ ...request, config: { abortSignal: abortState.signal, ...config } }),
    );

    const text = readResponseText(response);
    return {
      text: params.field === undefined ? text : readAnswerField(text, params.field),
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

  if (error instanceof ApiError) {
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
      true,
    );
  }

  const finishReason = response.candidates?.[0]?.finishReason;
  const finishMessage = response.candidates?.[0]?.finishMessage ?? null;
  if (finishReason === "SAFETY" || finishReason === "PROHIBITED_CONTENT") {
    throw new GeminiResultError(`Gemini refused this request (${finishReason}). Try different audio or wording.`, finishMessage, true);
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

// A structured answer is the JSON object its strict schema asked for; the field is
// read from it and held to the same non-empty rule as plain text.
function readAnswerField(text: string, field: string): string {
  let value: unknown;
  try {
    value = (JSON.parse(text) as Record<string, unknown> | null)?.[field];
  } catch {
    value = undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Gemini's answer did not hold the requested ${field}.`);
  }
  return normalizeResponseText(value);
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
