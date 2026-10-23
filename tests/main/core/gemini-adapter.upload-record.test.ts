import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CancelledError } from "@main/core/cancellation";
import {
  GeminiTimeoutError,
  INLINE_AUDIO_LIMIT_BYTES,
  transcribeWithGemini,
  type RecordProviderCall,
} from "@main/core/gemini-adapter";

type ProviderCall = Parameters<RecordProviderCall>[0];
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const endpoint = "https://proxy.example/gemini";
const uploadSession = "https://proxy.example/upload-session";
const json = (body: unknown, headers: Record<string, string> = {}) => new Response(
  JSON.stringify(body), { headers: { "content-type": "application/json", ...headers } },
);
const uploadedFile = { name: "files/late", uri: `${endpoint}/v1beta/files/late`, mimeType: "audio/mp4" };

describe("the physical upload's provider record", () => {
  const fetchMock = vi.fn<typeof fetch>();
  let root: string;
  let filePath: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mumbler-upload-record-"));
    filePath = join(root, "long.m4a");
    await writeFile(filePath, "");
    await truncate(filePath, INLINE_AUDIO_LIMIT_BYTES + 1);
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    { exit: "cancel", outcome: "success" },
    { exit: "deadline", outcome: "success" },
    { exit: "cancel", outcome: "failure" },
    { exit: "deadline", outcome: "failure" },
  ] as const)("records late physical $outcome after caller $exit without resubmitting", async ({ exit, outcome }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const uploadEntered = deferred<void>();
    const finishUpload = deferred<void>();
    const deleted = deferred<void>();
    const physicalFailure = new Error("The physical upload failed after the caller left.");
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === `${endpoint}/upload/v1beta/files`) return json({}, { "x-goog-upload-url": uploadSession });
      if (url === uploadSession) {
        const final = new Headers(init?.headers).get("x-goog-upload-command")?.includes("finalize") ?? false;
        if (!final) return json({}, { "x-goog-upload-status": "active" });
        uploadEntered.resolve();
        await finishUpload.promise;
        if (outcome === "failure") throw physicalFailure;
        return json({ file: uploadedFile }, { "x-goog-upload-status": "final" });
      }
      if (init?.method === "DELETE") { deleted.resolve(); return json({}); }
      throw new Error(`Unexpected provider request: ${url}`);
    });
    const calls: ProviderCall[] = [];
    const controller = new AbortController();
    let physical!: Promise<unknown>;
    let physicallySettled = false;
    const run = transcribeWithGemini({
      apiKey: "fixture-key", endpoint, filePath, mimeType: "audio/mp4", model: "custom", timeoutMs: 1000,
      signal: controller.signal,
      recordCall: async (call) => { calls.push(call); },
      trackWork: (work) => {
        physical = work;
        void work.then(() => { physicallySettled = true; }, () => { physicallySettled = true; });
      },
    }).catch((error: unknown) => error);
    try {
      await uploadEntered.promise;
      expect(calls.filter((call) => call.phase === "started")).toHaveLength(1);
      expect(calls.filter((call) => call.phase === "finished")).toHaveLength(0);
      if (exit === "cancel") controller.abort();
      else await vi.advanceTimersByTimeAsync(1000);
      expect(await run).toBeInstanceOf(exit === "cancel" ? CancelledError : GeminiTimeoutError);
      expect(physicallySettled).toBe(false);
      finishUpload.resolve();
      const actualOutcome = await physical.catch((error: unknown) => error);
      if (outcome === "success") await deleted.promise;
      const uploadCalls = calls.filter((call) => call.operation === "files.upload" && call.phase === "finished");
      expect(uploadCalls).toHaveLength(1);
      if (outcome === "success") {
        expect(uploadCalls[0]).toMatchObject({ response: uploadedFile, error: null });
      } else {
        expect(uploadCalls[0]?.response).toBeNull();
        expect(uploadCalls[0]?.error).toBe(actualOutcome);
        expect(actualOutcome).toBeInstanceOf(Error);
      }
      expect(physicallySettled).toBe(true);
      expect(fetchMock.mock.calls.filter(([url]) => String(url) === `${endpoint}/upload/v1beta/files`)).toHaveLength(1);
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/models/"))).toBe(false);
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(outcome === "success");
    } finally {
      finishUpload.resolve();
      await Promise.allSettled([run, physical]);
      if (outcome === "success") await deleted.promise;
    }
  });

  it("cancels the caller while the actual upload record is held without retaining physical capacity", async () => {
    const writingRecord = deferred<void>();
    const finishRecord = deferred<void>();
    const deleted = deferred<void>();
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === `${endpoint}/upload/v1beta/files`) return json({}, { "x-goog-upload-url": uploadSession });
      if (url === uploadSession) {
        const final = new Headers(init?.headers).get("x-goog-upload-command")?.includes("finalize") ?? false;
        return json(final ? { file: uploadedFile } : {}, { "x-goog-upload-status": final ? "final" : "active" });
      }
      if (init?.method === "DELETE") { deleted.resolve(); return json({}); }
      throw new Error(`Unexpected provider request: ${url}`);
    });
    const controller = new AbortController();
    const calls: ProviderCall[] = [];
    let physical!: Promise<unknown>;
    let physicallySettled = false;
    let callerSettled = false;
    const run = transcribeWithGemini({
      apiKey: "fixture-key", endpoint, filePath, mimeType: "audio/mp4", model: "custom", timeoutMs: 10_000,
      signal: controller.signal,
      recordCall: async (call) => {
        calls.push(call);
        if (call.operation === "files.upload" && call.phase === "finished") {
          writingRecord.resolve();
          await finishRecord.promise;
        }
      },
      trackWork: (work) => {
        physical = work;
        void work.then(() => { physicallySettled = true; }, () => { physicallySettled = true; });
      },
    }).catch((error: unknown) => { callerSettled = true; return error; });
    try {
      await writingRecord.promise;
      expect(physicallySettled).toBe(true);
      controller.abort();
      // Observe one event-loop turn while the record gate remains held; no
      // elapsed-time budget stands in for the known outstanding record work.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(callerSettled).toBe(true);
      expect(await run).toBeInstanceOf(CancelledError);
      expect(calls.find((call) => call.operation === "files.upload" && call.phase === "finished")).toMatchObject({ response: uploadedFile, error: null });
      finishRecord.resolve();
      await deleted.promise;
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/models/"))).toBe(false);
    } finally {
      finishRecord.resolve();
      await Promise.allSettled([run, physical]);
      await deleted.promise;
    }
  });
});
