import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApiError } from "@google/genai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GeminiTimeoutError,
  geminiProviderReason,
  generateTextWithGemini,
  INLINE_AUDIO_LIMIT_BYTES,
  isRetryableGeminiError,
  transcribeWithGemini,
} from "@main/core/gemini-adapter";
import { CancelledError, isCancelledError } from "@main/core/cancellation";

describe("isRetryableGeminiError", () => {
  it("does not retry timeouts or cancellations", () => {
    expect(isRetryableGeminiError(new GeminiTimeoutError(30000))).toBe(false);
    expect(isRetryableGeminiError(new CancelledError())).toBe(false);
  });

  it("retries only 408, 429, and 503 ApiErrors", () => {
    expect(isRetryableGeminiError(new ApiError({ message: "rate limited", status: 429 }))).toBe(
      true,
    );
    expect(isRetryableGeminiError(new ApiError({ message: "server", status: 408 }))).toBe(true);
    expect(isRetryableGeminiError(new ApiError({ message: "gateway", status: 503 }))).toBe(true);
  });

  it("does not retry client errors or ambiguous server failures", () => {
    expect(isRetryableGeminiError(new ApiError({ message: "bad request", status: 400 }))).toBe(
      false,
    );
    expect(isRetryableGeminiError(new ApiError({ message: "forbidden", status: 403 }))).toBe(false);
    for (const status of [500, 502, 504]) expect(isRetryableGeminiError(new ApiError({ message: "server", status }))).toBe(false);
  });

  it("retries a refused or unresolved connection, not a dropped one", () => {
    const failure = (code: string) => new TypeError("fetch failed", { cause: Object.assign(new Error(), { code }) });
    expect(isRetryableGeminiError(failure("ECONNREFUSED"))).toBe(true);
    expect(isRetryableGeminiError(failure("ENOTFOUND"))).toBe(true);
    expect(isRetryableGeminiError(failure("ECONNRESET"))).toBe(false);
  });

  it("does not infer retry policy from arbitrary exception prose", () => {
    expect(isRetryableGeminiError(new Error("network timeout while connecting"))).toBe(false);
    expect(isRetryableGeminiError(new Error("fetch failed"))).toBe(false);
    expect(isRetryableGeminiError(new Error("stream interrupted"))).toBe(false);
  });

  it("does not retry generic errors or non-error values", () => {
    expect(isRetryableGeminiError(new Error("invalid argument"))).toBe(false);
    expect(isRetryableGeminiError("boom")).toBe(false);
    expect(isRetryableGeminiError(null)).toBe(false);
  });
});

// The real SDK over a stubbed fetch: what the adapter asks of the SDK is what reaches
// the wire, with no network and no key.
describe("the Gemini SDK transport", () => {
  const endpoint = "https://proxy.example/gemini";
  const fetchMock = vi.fn<typeof fetch>();
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const answer = (text: string) => json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }], modelVersion: "served-model" });
  const generate = () => generateTextWithGemini({ apiKey: "fixture-key", endpoint, prompt: "hi", model: "custom", timeoutMs: 10_000 });
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mumbler-sdk-"));
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  });

  it("sends one request to the configured endpoint", async () => {
    fetchMock.mockResolvedValue(answer(" result "));
    expect(await generate()).toMatchObject({ text: "result", modelVersion: "served-model" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${endpoint}/v1beta/models/custom:generateContent`);
  });

  it("presents the provider's documented message and leaves a 503 to the pipeline's retry", async () => {
    fetchMock.mockResolvedValue(json({ error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" } }, 503));
    const error = await generate().catch((failure: unknown) => failure);
    expect(geminiProviderReason(error)).toBe("The model is overloaded.");
    expect(isRetryableGeminiError(error)).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps a body that is not the provider's JSON out of the presented reason", async () => {
    fetchMock.mockResolvedValue(new Response("TypeError EACCES /private/tmp/RAW-SENTINEL", { status: 500, statusText: "Internal Server Error" }));
    const error = await generate().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ApiError);
    expect(geminiProviderReason(error)).toBeNull();
    expect(isRetryableGeminiError(error)).toBe(false);
  });

  it("uploads through the resumable Files API at the configured endpoint and removes the upload", async () => {
    const filePath = join(root, "long.m4a");
    await writeFile(filePath, "");
    await truncate(filePath, INLINE_AUDIO_LIMIT_BYTES + 1);
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === `${endpoint}/upload/v1beta/files`) return json({}, 200, { "x-goog-upload-url": "https://proxy.example/upload-session" });
      if (url === "https://proxy.example/upload-session") {
        const final = new Headers(init?.headers).get("x-goog-upload-command")?.includes("finalize") ?? false;
        return json(final ? { file: { name: "files/one", uri: `${endpoint}/v1beta/files/one`, mimeType: "audio/mp4" } } : {}, 200, { "x-goog-upload-status": final ? "final" : "active" });
      }
      return init?.method === "DELETE" ? json({}) : answer("transcript");
    });

    const result = await transcribeWithGemini({ apiKey: "fixture-key", endpoint, filePath, mimeType: "audio/mp4", model: "custom", timeoutMs: 10_000 });

    expect(result).toMatchObject({ transport: "files-api", text: "transcript" });
    const [startUrl, startInit] = fetchMock.mock.calls[0]!;
    expect(String(startUrl)).toBe(`${endpoint}/upload/v1beta/files`);
    expect(new Headers(startInit?.headers).get("x-goog-upload-protocol")).toBe("resumable");
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => init?.method === "DELETE" && String(url) === `${endpoint}/v1beta/files/one`)).toBe(true));
  });
});

describe("isCancelledError", () => {
  it("matches only the cancellation error", () => {
    expect(isCancelledError(new CancelledError())).toBe(true);
    expect(isCancelledError(new GeminiTimeoutError(1000))).toBe(false);
    expect(isCancelledError(new Error("x"))).toBe(false);
  });
});
