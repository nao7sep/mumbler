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

vi.mock("@main/core/gemini-http", () => ({
  GeminiClient: class {
    generateContent = generateContent;
    upload = upload;
    delete = deleteFile;
  },
  GeminiHttpError: class extends Error {},

}));

vi.mock("node:fs/promises", () => ({ stat, readFile }));

import { ApiError } from "@google/genai";

import {
  GeminiTimeoutError,
  generateTextWithGemini,
  getInlineAudioSafetyLimitBytes,
  transcribeWithGemini,
} from "@main/core/gemini-adapter";
import { CancelledError } from "@main/core/cancellation";

const SAFE = getInlineAudioSafetyLimitBytes();

function baseParams() {
  return {
    apiKey: "test-key",
    filePath: "/tmp/rec.m4a",
    mimeType: "audio/mp4",
    model: "gemini-3.8-flash",
    timeoutMs: 60_000,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  deleteFile.mockResolvedValue(undefined);
  readFile.mockResolvedValue("YmFzZTY0");
});

// Family policy is stated on every generation transport.
describe("thinking is stated on every model call", () => {
  const DYNAMIC = { thinkingLevel: "medium" };

  it("states medium thinking on the inline transcription call", async () => {
    stat.mockResolvedValue({ size: SAFE - 1 });
    generateContent.mockResolvedValue({ text: "hi", modelVersion: "v1", usageMetadata: null });

    await transcribeWithGemini(baseParams());

    expect(generateContent.mock.calls[0]?.[0].config.thinkingConfig).toEqual(DYNAMIC);
  });

  it("states medium thinking on the Files-API transcription call", async () => {
    stat.mockResolvedValue({ size: SAFE + 1 });
    upload.mockResolvedValue({ name: "files/abc", uri: "gs://u", mimeType: "audio/mp4" });
    generateContent.mockResolvedValue({ text: "done", modelVersion: "v1", usageMetadata: null });

    await transcribeWithGemini(baseParams());

    expect(generateContent.mock.calls[0]?.[0].config.thinkingConfig).toEqual(DYNAMIC);
    // The upload is a file transfer, not a generation — it must not carry one.
    expect(upload.mock.calls[0]?.[0].config).not.toHaveProperty("thinkingConfig");
  });

  it("states medium thinking on the text-generation call", async () => {
    generateContent.mockResolvedValue({ text: "out", modelVersion: "v1", usageMetadata: null });

    await generateTextWithGemini({
      apiKey: "test-key",
      prompt: "hi",
      model: "gemini-3.8-flash",
      timeoutMs: 60_000,
    });

    expect(generateContent.mock.calls[0]?.[0].config.thinkingConfig).toEqual(DYNAMIC);
  });

  it("uses the resolved family policy without a legacy thinking budget", async () => {
    stat.mockResolvedValue({ size: SAFE - 1 });
    generateContent.mockResolvedValue({ text: "hi", modelVersion: "v1", usageMetadata: null });

    await transcribeWithGemini(baseParams());

    expect(generateContent.mock.calls[0]?.[0].config.thinkingConfig).toEqual(DYNAMIC);
  });
});

describe("model policy and the decimal audio threshold", () => {
  it("omits thinking for unknown ids while preserving the metadata ceiling", async () => {
    generateContent.mockResolvedValue({ text: "result" });
    await generateTextWithGemini({ apiKey: "fixture", prompt: "title", model: "unknown", timeoutMs: 1000 });
    const config = generateContent.mock.calls[0]![0].config;
    expect(config).not.toHaveProperty("thinkingConfig");
    expect(config.maxOutputTokens).toBe(1024);
  });

  it("uses dynamic thinking for 2.5 and the outline ceiling", async () => {
    generateContent.mockResolvedValue({ text: "result" });
    await generateTextWithGemini({ apiKey: "fixture", prompt: "outline", model: "gemini-2.5-pro", role: "outline", timeoutMs: 1000 });
    expect(generateContent.mock.calls[0]![0].config).toMatchObject({ thinkingConfig: { thinkingBudget: -1 }, maxOutputTokens: 65536 });
  });

  it("uses inline audio through 20,000,000 bytes and Files API above it", async () => {
    expect(SAFE).toBe(20_000_000);
    stat.mockResolvedValue({ size: SAFE });
    generateContent.mockResolvedValue({ text: "result" });
    expect((await transcribeWithGemini(baseParams())).transport).toBe("inline");
    expect(generateContent.mock.calls[0]![0].config.maxOutputTokens).toBe(65536);
    stat.mockResolvedValue({ size: SAFE + 1 });
    upload.mockResolvedValue({ name: "files/fixture", uri: "https://provider.example/file" });
    expect((await transcribeWithGemini(baseParams())).transport).toBe("files-api");
  });
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
    expect(deleteFile).toHaveBeenCalledWith({
      name: "files/abc",
      config: {
        abortSignal: expect.any(AbortSignal),
      },
    });
  });

  it("deletes the uploaded file even when generation fails", async () => {
    stat.mockResolvedValue({ size: SAFE + 1 });
    upload.mockResolvedValue({ name: "files/xyz", uri: "gs://u" });
    generateContent.mockRejectedValue(new Error("boom"));

    await expect(transcribeWithGemini(baseParams())).rejects.toThrow("boom");
    expect(deleteFile).toHaveBeenCalledWith({
      name: "files/xyz",
      config: {
        abortSignal: expect.any(AbortSignal),
      },
    });
  });

  it("returns the transcript without waiting for a delete that stalls", async () => {
    stat.mockResolvedValue({ size: SAFE + 1 });
    upload.mockResolvedValue({ name: "files/slow", uri: "gs://u" });
    generateContent.mockResolvedValue({ text: "kept", modelVersion: "v1", usageMetadata: null });
    let deleteSignal: AbortSignal | undefined;
    deleteFile.mockImplementation(({ config }: { config: { abortSignal: AbortSignal } }) => {
      deleteSignal = config.abortSignal;
      return new Promise(() => undefined);
    });

    const result = await transcribeWithGemini(baseParams());

    expect(result.text).toBe("kept");
    expect(deleteSignal?.aborted, "the delete carries its own bound").toBe(false);
  });
});

describe("transcribeWithGemini cancellation and timeout", () => {
  it("rejects immediately with a cancelled error when the signal is already aborted", async () => {
    stat.mockResolvedValue({ size: SAFE - 1 });
    const controller = new AbortController();
    controller.abort();

    await expect(
      transcribeWithGemini({ ...baseParams(), signal: controller.signal }),
    ).rejects.toBeInstanceOf(CancelledError);
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

describe("the transport never adds a retry", () => {
  it("propagates a 503 after exactly one generation call", async () => {
    stat.mockResolvedValue({ size: SAFE - 1 });
    generateContent.mockRejectedValue(new ApiError({ message: "busy", status: 503 }));
    await expect(transcribeWithGemini(baseParams())).rejects.toThrow("busy");
    expect(generateContent).toHaveBeenCalledOnce();
  });

  it("propagates an upload failure after exactly one upload", async () => {
    stat.mockResolvedValue({ size: SAFE + 1 });
    upload.mockRejectedValue(new ApiError({ message: "busy", status: 503 }));
    await expect(transcribeWithGemini(baseParams())).rejects.toThrow("busy");
    expect(upload).toHaveBeenCalledOnce();
    expect(generateContent).not.toHaveBeenCalled();
  });
});
