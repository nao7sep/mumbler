import { readFile, stat } from "node:fs/promises";

import { ApiError, GoogleGenAI, type GenerateContentResponse } from "@google/genai";

import { type AppLogger } from "./logger";

const INLINE_REQUEST_LIMIT_BYTES = 20 * 1024 * 1024;
const INLINE_AUDIO_SAFETY_LIMIT_BYTES = 18 * 1024 * 1024;

export interface GeminiAudioTranscriptionParams {
  apiKey: string;
  filePath: string;
  mimeType: string;
  model: string;
  language: string;
  timeoutMs: number;
  logger?: AppLogger;
}

export interface GeminiTextGenerationParams {
  apiKey: string;
  prompt: string;
  model: string;
  timeoutMs: number;
}

export interface GeminiRunResult {
  text: string;
  modelVersion: string | null;
  usageMetadata: unknown;
  transport: "inline" | "files-api";
}

export async function transcribeWithGemini(
  params: GeminiAudioTranscriptionParams,
): Promise<GeminiRunResult> {
  const ai = new GoogleGenAI({ apiKey: params.apiKey });
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), params.timeoutMs);
  let uploadedFileName: string | null = null;
  let transport: GeminiRunResult["transport"] = "inline";

  try {
    const fileStats = await stat(params.filePath);
    const prompt = buildTranscriptionPrompt(params.language);

    let response: GenerateContentResponse;
    if (fileStats.size <= INLINE_AUDIO_SAFETY_LIMIT_BYTES) {
      const inlineData = await readFile(params.filePath, { encoding: "base64" });
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
          abortSignal: controller.signal,
        },
      });
    } else {
      transport = "files-api";
      const uploadedFile = await ai.files.upload({
        file: params.filePath,
        config: {
          mimeType: params.mimeType,
          abortSignal: controller.signal,
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
          abortSignal: controller.signal,
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
  } finally {
    clearTimeout(timeoutId);
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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), params.timeoutMs);

  try {
    const response = await ai.models.generateContent({
      model: params.model,
      contents: [
        {
          role: "user",
          parts: [{ text: params.prompt }],
        },
      ],
      config: {
        abortSignal: controller.signal,
      },
    });

    return {
      text: normalizeResponseText(response.text),
      modelVersion: response.modelVersion ?? null,
      usageMetadata: response.usageMetadata ?? null,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export function isRetryableGeminiError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status === 429 || error.status >= 500;
  }

  if (error instanceof Error) {
    return (
      error.name === "AbortError" ||
      /network|timeout|timed out|fetch|stream/i.test(error.message)
    );
  }

  return false;
}

export function getInlineAudioSafetyLimitBytes(): number {
  return INLINE_AUDIO_SAFETY_LIMIT_BYTES;
}

export function getInlineRequestLimitBytes(): number {
  return INLINE_REQUEST_LIMIT_BYTES;
}

function buildTranscriptionPrompt(language: string): string {
  return [
    "Generate a faithful transcript of the spoken audio.",
    "Return only the transcript text.",
    "Do not add summaries, timestamps, headings, speaker labels, markdown, or explanations.",
    `Expected primary language hint: ${language}. If the audio clearly uses a different language, follow the audio instead of the hint.`,
  ].join(" ");
}

function normalizeResponseText(value: string | undefined): string {
  const normalized = value?.trim() ?? "";
  if (normalized.length === 0) {
    throw new Error("Gemini returned an empty text response.");
  }

  return normalized;
}
