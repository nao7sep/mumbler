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
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          url: "https://example.test/checksums.sha256",
          text: () =>
            new Promise<string>((_resolve, reject) => {
              signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            }),
        } as Response;
      }),
    );

    const reading = fetchText("https://example.test/checksums.sha256", {}, 25);
    const timedOut = expect(reading).rejects.toThrow(/timed out fetching/);
    await vi.advanceTimersByTimeAsync(26);

    await timedOut;
  });
});
