import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadToFile, fetchText } from "@main/core/binaries/http";

function responseAt(
  url: string,
  body: BodyInit | null = "ok",
  init: ResponseInit = { status: 200 },
): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: url });
  return response;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
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
