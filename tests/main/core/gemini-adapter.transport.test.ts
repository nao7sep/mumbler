import { beforeEach, describe, expect, it, vi } from "vitest";

// The external-call surface (transport selection, timeout/abort normalization,
// Files-API cleanup) is the most failure-prone path in the app. Mock the Gemini
// SDK and fs so it can be exercised deterministically without a network or a key.
// Kept in its own file so the SDK mock doesn't leak into gemini-adapter.test.ts,
// which needs the real ApiError class.
const { generateContent, upload, deleteFile, stat, readFile } = vi.hoisted(() => ({
  generateContent: vi.fn(),
  upload: vi.fn(),
  deleteFile: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent };
    files = { upload, delete: deleteFile };
  },
  ApiError: class ApiError extends Error {},
}));

vi.mock("node:fs/promises", () => ({ stat, readFile }));

import {
  GeminiCancelledError,
  GeminiTimeoutError,
  generateTextWithGemini,
  getInlineAudioSafetyLimitBytes,
  transcribeWithGemini,
} from "@main/core/gemini-adapter";

const SAFE = getInlineAudioSafetyLimitBytes();

function baseParams() {
  return {
    apiKey: "test-key",
    filePath: "/tmp/rec.m4a",
    mimeType: "audio/mp4",
    model: "gemini-test",
    timeoutMs: 60_000,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  deleteFile.mockResolvedValue(undefined);
  readFile.mockResolvedValue("YmFzZTY0");
});

describe("transcribeWithGemini transport selection", () => {
  it("sends small files inline and never touches the Files API", async () => {
    stat.mockResolvedValue({ size: SAFE - 1 });
    generateContent.mockResolvedValue({
      text: "  hello  ",
      modelVersion: "v1",
      usageMetadata: { totalTokenCount: 5 },
    });

    const result = await transcribeWithGemini(baseParams());

    expect(result.transport).toBe("inline");
    expect(result.text).toBe("hello");
    expect(result.modelVersion).toBe("v1");
    expect(upload).not.toHaveBeenCalled();
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it("uploads large files via the Files API and deletes the upload afterward", async () => {
    stat.mockResolvedValue({ size: SAFE + 1 });
    upload.mockResolvedValue({ name: "files/abc", uri: "gs://u", mimeType: "audio/mp4" });
    generateContent.mockResolvedValue({ text: "done", modelVersion: "v1", usageMetadata: null });

    const result = await transcribeWithGemini(baseParams());

    expect(result.transport).toBe("files-api");
    expect(upload).toHaveBeenCalledTimes(1);
    expect(deleteFile).toHaveBeenCalledWith({ name: "files/abc" });
  });

  it("deletes the uploaded file even when generation fails", async () => {
    stat.mockResolvedValue({ size: SAFE + 1 });
    upload.mockResolvedValue({ name: "files/xyz", uri: "gs://u" });
    generateContent.mockRejectedValue(new Error("boom"));

    await expect(transcribeWithGemini(baseParams())).rejects.toThrow("boom");
    expect(deleteFile).toHaveBeenCalledWith({ name: "files/xyz" });
  });
});

describe("transcribeWithGemini cancellation and timeout", () => {
  it("rejects immediately with a cancelled error when the signal is already aborted", async () => {
    stat.mockResolvedValue({ size: SAFE - 1 });
    const controller = new AbortController();
    controller.abort();

    await expect(
      transcribeWithGemini({ ...baseParams(), signal: controller.signal }),
    ).rejects.toBeInstanceOf(GeminiCancelledError);
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("maps an internal-timeout abort to a timeout error", async () => {
    stat.mockResolvedValue({ size: SAFE - 1 });
    generateContent.mockImplementation(({ config }: { config: { abortSignal: AbortSignal } }) => {
      return new Promise((_resolve, reject) => {
        config.abortSignal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    });

    await expect(
      transcribeWithGemini({ ...baseParams(), timeoutMs: 5 }),
    ).rejects.toBeInstanceOf(GeminiTimeoutError);
  });

  it("rejects when the model returns an empty response", async () => {
    stat.mockResolvedValue({ size: SAFE - 1 });
    generateContent.mockResolvedValue({ text: "   ", modelVersion: "v1", usageMetadata: null });

    await expect(transcribeWithGemini(baseParams())).rejects.toThrow(/empty/i);
  });
});

describe("generateTextWithGemini", () => {
  it("returns trimmed text with no transport field", async () => {
    generateContent.mockResolvedValue({ text: " result ", modelVersion: "v1", usageMetadata: null });

    const result = await generateTextWithGemini({
      apiKey: "test-key",
      prompt: "hi",
      model: "gemini-test",
      timeoutMs: 60_000,
    });

    expect(result.text).toBe("result");
    expect(result).not.toHaveProperty("transport");
  });

  it("rejects immediately when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      generateTextWithGemini({
        apiKey: "test-key",
        prompt: "hi",
        model: "gemini-test",
        timeoutMs: 60_000,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(GeminiCancelledError);
    expect(generateContent).not.toHaveBeenCalled();
  });
});
