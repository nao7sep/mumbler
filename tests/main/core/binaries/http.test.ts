import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { downloadToFile, fetchText, resolveRedirectLocation } from "@main/core/binaries/http";

let root = "";
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "mumbler-http-")); });

function responseAt(
  url: string,
  body: BodyInit | null = "ok",
  init: ResponseInit = { status: 200 },
): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: url });
  return response;
}

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

const URL = "https://example.test/tool.zip";
const text = () => fetchText(URL, {}, 25, undefined, 10);
const download = () => downloadToFile({ url: URL, destPath: join(root, "tool.zip"), maxBytes: 10, idleTimeoutMs: 25 });

interface DiscardCase {
  name: string;
  run: () => Promise<unknown>;
  init: ResponseInit;
  responseUrl?: string;
  error?: RegExp;
  value?: unknown;
}

const discardedResponses: DiscardCase[] = [
  { name: "resolved redirect", run: () => resolveRedirectLocation(URL, 25), init: { status: 307, headers: { Location: "/download/tool.zip" } }, value: "https://example.test/download/tool.zip" },
  { name: "rejected redirect status", run: () => resolveRedirectLocation(URL, 25), init: { status: 200 }, error: /expected a redirect/ },
  { name: "insecure redirect location", run: () => resolveRedirectLocation(URL, 25), init: { status: 307, headers: { Location: "http://mirror.test/tool.zip" } }, error: /refusing non-https/ },
  { name: "metadata status failure", run: text, init: { status: 503 }, error: /HTTP 503/ },
  { name: "followed redirect without Location", run: text, init: { status: 307 }, error: /omitted Location/ },
  { name: "insecure followed redirect", run: text, init: { status: 307, headers: { Location: "http://mirror.test/tool.zip" } }, error: /refusing non-https/ },
  { name: "invalid metadata length", run: text, init: { status: 200, headers: { "Content-Length": "invalid" } }, error: /invalid Content-Length/ },
  { name: "oversized metadata header", run: text, init: { status: 200, headers: { "Content-Length": "11" } }, error: /text response too large/ },
  { name: "download status failure", run: download, init: { status: 503 }, error: /HTTP 503/ },
  { name: "oversized download header", run: download, init: { status: 200, headers: { "Content-Length": "11" } }, error: /tool download too large/ },
  { name: "insecure effective metadata URL", run: text, init: { status: 200 }, responseUrl: "http://example.test/tool.zip", error: /refusing non-https/ },
  { name: "insecure effective download URL", run: download, init: { status: 200 }, responseUrl: "http://example.test/tool.zip", error: /refusing non-https/ },
];

describe("discarded response ownership", () => {
  it.each(discardedResponses)("settles body cancellation before returning from $name", async (testCase) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let entered!: () => void;
    let release!: () => void;
    const cancelling = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const cancel = vi.fn(() => { entered(); return held; });
    const body = new ReadableStream<Uint8Array>({ cancel });
    let transferSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      transferSignal = init?.signal ?? undefined;
      return responseAt(testCase.responseUrl ?? URL, body, testCase.init);
    });
    vi.stubGlobal("fetch", fetchMock);
    let settled = false;
    const result = testCase.run().then(
      (value) => { settled = true; return { value }; },
      (error: unknown) => { settled = true; return { error }; },
    );
    try {
      // A baseline that drops the body settles first, so this assertion fails
      // immediately rather than hanging while waiting for an absent cancel.
      expect(await Promise.race([cancelling.then(() => true), result.then(() => false)])).toBe(true);
      expect(cancel).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(26);
      expect(transferSignal?.aborted, "the transfer deadline still owns held disposal").toBe(true);
      expect(settled).toBe(false);
      release();
      const outcome = await result;
      if (testCase.error) {
        expect(outcome).toHaveProperty("error", expect.objectContaining({ message: expect.stringMatching(testCase.error) }));
      } else expect(outcome).toEqual({ value: testCase.value });
      fetchMock.mockImplementation(async () => responseAt(URL, "next"));
      expect(await fetchText(URL)).toBe("next");
    } finally {
      release();
      await result;
      await body.cancel().catch(() => undefined);
    }
  });

  it.each(["location", "failure"] as const)("keeps the primary %s when body cancellation rejects", async (outcome) => {
    const cancel = vi.fn(async () => { throw new Error("secondary disposal failure"); });
    vi.stubGlobal("fetch", vi.fn(async () => responseAt(URL, new ReadableStream({ cancel }), outcome === "location"
      ? { status: 307, headers: { Location: "/download/tool.zip" } }
      : { status: 503 })));
    if (outcome === "location") await expect(resolveRedirectLocation(URL)).resolves.toBe("https://example.test/download/tool.zip");
    else await expect(fetchText(URL)).rejects.toThrow(/HTTP 503/);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("settles a followed redirect body before issuing the next request", async () => {
    let entered!: () => void;
    let release!: () => void;
    const cancelling = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const cancel = vi.fn(() => { entered(); return held; });
    const redirected = new ReadableStream<Uint8Array>({ cancel });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(responseAt(URL, redirected, { status: 307, headers: { Location: "/checksums.sha256" } }))
      .mockResolvedValueOnce(responseAt("https://example.test/checksums.sha256", "next"));
    vi.stubGlobal("fetch", fetchMock);
    const result = fetchText(URL);
    try {
      await cancelling;
      expect(fetchMock).toHaveBeenCalledOnce();
      release();
      expect(await result).toBe("next");
      expect(fetchMock).toHaveBeenNthCalledWith(2, "https://example.test/checksums.sha256", expect.anything());
      expect(cancel).toHaveBeenCalledOnce();
    } finally { release(); await result; }
  });

  it("keeps normal text and download stream completion with their existing readers", async () => {
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => responseAt(URL, new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("bytes")); controller.close(); },
      cancel,
    }))));
    expect(await fetchText(URL)).toBe("bytes");
    await download();
    expect(await readFile(join(root, "tool.zip"), "utf8")).toBe("bytes");
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("managed tool HTTPS transport", () => {
  it("refuses an effective HTTP URL after a followed text redirect", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => responseAt("http://example.test/checksums.sha256")));

    await expect(fetchText("https://example.test/checksums.sha256")).rejects.toThrow(
      /refusing non-https tool URL/,
    );
  });

  it("refuses an insecure intermediate redirect even when the next URL is HTTPS", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        responseAt("https://example.test/tool.zip", null, {
          status: 302,
          headers: { Location: "http://mirror.test/tool.zip" },
        }),
      )
      .mockResolvedValueOnce(responseAt("https://attacker.test/tool.zip", "bytes"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchText("https://example.test/tool.zip")).rejects.toThrow(
      /refusing non-https tool URL/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses an effective HTTP URL after a followed download redirect", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => responseAt("http://example.test/tool.zip", "bytes")));

    await expect(
      downloadToFile({
        url: "https://example.test/tool.zip",
        destPath: join(tmpdir(), "mumbler-https-downgrade-should-not-exist"),
        maxBytes: 1024,
      }),
    ).rejects.toThrow(/refusing non-https tool URL/);
  });

  it("keeps the timeout active while the text body is read", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener(
              "abort",
              () => controller.error(signal.reason),
              { once: true },
            );
          },
        });
        return responseAt("https://example.test/checksums.sha256", body);
      }),
    );

    const reading = fetchText("https://example.test/checksums.sha256", {}, 25);
    const timedOut = expect(reading).rejects.toThrow(/timed out fetching/);
    await vi.advanceTimersByTimeAsync(26);

    await timedOut;
  });

  it("rejects an oversized advertised metadata body before reading it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        responseAt("https://example.test/checksums.sha256", "small", {
          status: 200,
          headers: { "Content-Length": "100" },
        }),
      ),
    );

    await expect(
      fetchText("https://example.test/checksums.sha256", {}, 30_000, undefined, 10),
    ).rejects.toThrow(/text response too large/);
  });

  it("stops before retaining a streamed metadata body past its byte cap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responseAt("https://example.test/checksums.sha256", "12345")),
    );

    await expect(
      fetchText("https://example.test/checksums.sha256", {}, 30_000, undefined, 4),
    ).rejects.toThrow(/text response exceeded cap/);
  });
});
