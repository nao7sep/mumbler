import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GeminiClient, GeminiHttpError } from "@main/core/gemini-http";
import { generationPolicy } from "@shared/model-registry";
import { isRetryableGeminiError, retryAfterDelayMs } from "@main/core/gemini-adapter";

const fetchMock = vi.fn<typeof fetch>();
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mumbler-http-"));
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => { vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });

const client = () => new GeminiClient({ apiKey: "fixture-key", endpoint: "https://proxy.example/gemini" });
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("Gemini HTTP boundaries", () => {
  it("uses the configured endpoint while model policy remains tied to the id", async () => {
    fetchMock.mockResolvedValue(json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "answer" }] } }], modelVersion: "served-model" }));
    const signal = new AbortController().signal;
    const response = await client().generateContent({ model: "gemini-3.8-flash", contents: [{ role: "user", parts: [{ text: "outline" }] }], config: { abortSignal: signal, ...generationPolicy("gemini-3.8-flash", "outline") } });
    expect(response.text).toBe("answer");
    expect(response.modelVersion).toBe("served-model");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://proxy.example/gemini/v1beta/models/gemini-3.8-flash:generateContent");
    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.signal).toBe(signal);
    expect(JSON.parse(init.body as string).generationConfig).toEqual({ thinkingConfig: { thinkingLevel: "medium" }, maxOutputTokens: 65536 });
  });

  it("preserves documented provider messages and capped Retry-After without retrying", async () => {
    fetchMock.mockResolvedValue(json({ error: { message: "Please wait before trying again.", code: 429 } }, 429, { "retry-after": "120" }));
    const error = await client().generateContent({ model: "custom", contents: [], config: { abortSignal: new AbortController().signal } }).catch((failure) => failure);
    expect(error).toBeInstanceOf(GeminiHttpError);
    expect(error.providerMessage).toBe("Please wait before trying again.");
    expect(isRetryableGeminiError(error)).toBe(true);
    expect(retryAfterDelayMs(error)).toBe(30_000);
    expect(fetchMock).toHaveBeenCalledOnce();
    const now = Date.parse("2026-10-01T00:00:00Z");
    expect(retryAfterDelayMs(new GeminiHttpError("busy", 503, "Thu, 01 Oct 2026 00:00:10 GMT"), now)).toBe(10_000);
    expect(retryAfterDelayMs(new GeminiHttpError("busy", 503, "not a date"), now)).toBeNull();
  });

  it("keeps arbitrary transport text diagnostic-only and distinguishes refused from dropped connections", async () => {
    fetchMock.mockResolvedValue(new Response("TypeError EACCES /private/tmp/RAW-SENTINEL", { status: 500 }));
    const error = await client().generateContent({ model: "custom", contents: [], config: { abortSignal: new AbortController().signal } }).catch((failure) => failure);
    expect(error.providerMessage).toBeNull();
    expect(isRetryableGeminiError(error)).toBe(false);
    expect(isRetryableGeminiError(new TypeError("fetch failed", { cause: Object.assign(new Error(), { code: "ECONNREFUSED" }) }))).toBe(true);
    expect(isRetryableGeminiError(new TypeError("fetch failed", { cause: Object.assign(new Error(), { code: "ECONNRESET" }) }))).toBe(false);
  });

  it("uploads bytes through the resumable Files API and removes the remote file", async () => {
    const file = join(root, "audio.wav");
    await writeFile(file, "audio");
    fetchMock.mockResolvedValueOnce(new Response(null, { headers: { "x-goog-upload-url": "https://proxy.example/upload-session" } }));
    fetchMock.mockResolvedValueOnce(json({ file: { name: "files/one", uri: "https://proxy.example/files/one", mimeType: "audio/wav" } }));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = client();
    const signal = new AbortController().signal;
    expect(await api.upload({ file, config: { mimeType: "audio/wav", abortSignal: signal } })).toMatchObject({ name: "files/one" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://proxy.example/gemini/upload/v1beta/files");
    const init = fetchMock.mock.calls[1]![1]!;
    expect(init.headers).toMatchObject({ "X-Goog-Upload-Command": "upload, finalize" });
    expect(await (init.body as Blob).text()).toBe("audio");
    expect(init.signal).toBe(signal);
    await api.delete({ name: "files/one", config: { abortSignal: signal } });
    expect(fetchMock.mock.calls[2]?.[0]).toBe("https://proxy.example/gemini/v1beta/files/one");
  });

  it("follows model-list pages and excludes models without generateContent", async () => {
    fetchMock.mockResolvedValueOnce(json({ models: [{ name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] }, { name: "models/embedding", supportedGenerationMethods: ["embedContent"] }], nextPageToken: "next" }));
    fetchMock.mockResolvedValueOnce(json({ models: [{ name: "models/gemini-next", supportedGenerationMethods: ["generateContent"] }] }));
    expect(await client().list(new AbortController().signal)).toEqual(["gemini-3.8-flash", "gemini-next"]);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("pageToken=next");
  });
});
