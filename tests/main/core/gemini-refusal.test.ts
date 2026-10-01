import { describe, it, expect, vi, beforeEach } from "vitest";

const generateContent = vi.fn();
vi.mock("@google/genai", () => ({
  GoogleGenAI: class { models = { generateContent }; files = { upload: vi.fn(), get: vi.fn() }; },
  ApiError: class extends Error {},
}));

import { generateTextWithGemini, geminiProviderReason, isRetryableGeminiError } from "@main/core/gemini-adapter";

const call = () => generateTextWithGemini({
  apiKey: "k", model: "gemini-3.7-flash", prompt: "hi", timeoutMs: 1000,
});

beforeEach(() => generateContent.mockReset());

// Each case is a response the provider DID explain. Reporting "empty response" for any of
// them states something untrue — see ai-model-routing-conventions, "never invent a cause".
describe("a refused or truncated Gemini response reports the provider's reason", () => {
  it("surfaces a prompt-level block instead of calling it empty", async () => {
    // The exact shape observed live on 2026-08-20 for blocked audio: no candidates at all.
    generateContent.mockResolvedValue({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" }, text: undefined });
    await expect(call()).rejects.toThrow(/refused this request \(PROHIBITED_CONTENT\)/);
    await expect(call()).rejects.not.toThrow(/empty text response/);
  });

  it("names a truncated result rather than returning it as complete", async () => {
    generateContent.mockResolvedValue({ candidates: [{ finishReason: "MAX_TOKENS" }], text: "half an ans" });
    await expect(call()).rejects.toThrow(/truncated/);
  });

  it("reports any other non-STOP finish reason", async () => {
    generateContent.mockResolvedValue({ candidates: [{ finishReason: "SAFETY" }], text: "" });
    await expect(call()).rejects.toThrow(/refused this request \(SAFETY\)/);
  });

  it("presents only the provider's documented refusal message and never retries it", async () => {
    generateContent.mockResolvedValue({ candidates: [{ finishReason: "SAFETY", finishMessage: "Please use different audio." }], text: "" });
    const error = await call().catch((failure) => failure);
    expect(geminiProviderReason(error)).toBe("Please use different audio.");
    expect(isRetryableGeminiError(error)).toBe(false);
    generateContent.mockResolvedValue({ candidates: [{ finishReason: "SAFETY" }], text: "" });
    expect(geminiProviderReason(await call().catch((failure) => failure))).toBeNull();
  });

  it("marks a refusal as refused, and a truncation as not", async () => {
    generateContent.mockResolvedValue({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" }, text: undefined });
    expect(await call().catch((failure) => failure)).toMatchObject({ refused: true });
    generateContent.mockResolvedValue({ candidates: [{ finishReason: "PROHIBITED_CONTENT" }], text: "" });
    expect(await call().catch((failure) => failure)).toMatchObject({ refused: true });
    generateContent.mockResolvedValue({ candidates: [{ finishReason: "MAX_TOKENS" }], text: "half" });
    expect(await call().catch((failure) => failure)).toMatchObject({ refused: false });
  });

  it("still returns text on a normal stop, and when no finishReason is given at all", async () => {
    generateContent.mockResolvedValue({ candidates: [{ finishReason: "STOP" }], text: "ok" });
    await expect(call()).resolves.toMatchObject({ text: "ok" });
    generateContent.mockResolvedValue({ text: "ok" });
    await expect(call()).resolves.toMatchObject({ text: "ok" });
  });

  it("keeps the genuine empty-response error for a response that explains nothing", async () => {
    generateContent.mockResolvedValue({ text: "" });
    await expect(call()).rejects.toThrow(/empty text response/);
  });
});
