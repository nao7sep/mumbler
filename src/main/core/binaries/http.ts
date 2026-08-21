import { createWriteStream } from "node:fs";
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

// Minimal HTTPS download/resolve helpers for the managed audio tools. Every URL
// is https-only (refused up front), every transfer is bounded by a byte cap and
// an idle watchdog, and the body streams to disk so a ~27 MB archive never sits
// in memory. The managed-runtime-dependencies-conventions' https-only transport rule.

function assertHttps(url: string): void {
  let scheme = "";
  try {
    scheme = new URL(url).protocol;
  } catch {
    throw new Error(`invalid tool URL: ${url}`);
  }
  if (scheme !== "https:") {
    throw new Error(`refusing non-https tool URL: ${url}`);
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function fetchFollowingHttpsRedirects(
  url: string,
  init: Omit<RequestInit, "redirect" | "signal">,
  signal: AbortSignal,
): Promise<Response> {
  let currentUrl = url;
  for (let redirectCount = 0; ; redirectCount += 1) {
    assertHttps(currentUrl);
    const response = await fetch(currentUrl, { ...init, redirect: "manual", signal });
    if (!REDIRECT_STATUSES.has(response.status)) {
      assertHttps(response.url || currentUrl);
      return response;
    }

    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (location === null) {
      throw new Error(`redirect from ${currentUrl} omitted Location`);
    }
    if (redirectCount >= 10) {
      throw new Error(`too many redirects fetching ${url}`);
    }
    currentUrl = new URL(location, currentUrl).toString();
    assertHttps(currentUrl);
  }
}

// Resolve a single redirect hop without following it — martin-riedl's
// `/redirect/latest/...` 307s to the versioned `/download/...` path, and that
// Location is both the download URL and the carrier of the version. Returns the
// absolute Location.
export async function resolveRedirectLocation(
  url: string,
  idleTimeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<string> {
  assertHttps(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out resolving ${url}`)), idleTimeoutMs);
  const combinedSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  let res: Response;
  try {
    res = await fetch(url, { method: "GET", redirect: "manual", signal: combinedSignal });
  } finally {
    clearTimeout(timer);
  }
  const location = res.headers.get("location");
  if (res.status < 300 || res.status >= 400 || !location) {
    throw new Error(`expected a redirect from ${url}, got HTTP ${res.status}`);
  }
  // Resolve a relative Location against the request URL.
  const resolved = new URL(location, url).toString();
  assertHttps(resolved);
  return resolved;
}

export async function fetchText(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 30_000,
  signal?: AbortSignal,
  maxBytes = 1024 * 1024,
): Promise<string> {
  assertHttps(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out fetching ${url}`)), timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  try {
    const res = await fetchFollowingHttpsRedirects(url, { headers }, combinedSignal);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} from ${url}`);
    }
    const advertisedRaw = res.headers.get("content-length");
    if (advertisedRaw !== null) {
      const advertised = Number(advertisedRaw);
      if (!Number.isSafeInteger(advertised) || advertised < 0) {
        throw new Error(`invalid Content-Length from ${url}: ${advertisedRaw}`);
      }
      if (advertised > maxBytes) {
        throw new Error(`text response too large: ${advertised} bytes > cap ${maxBytes} from ${url}`);
      }
    }

    if (res.body === null) return "";
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        received += next.value.byteLength;
        if (received > maxBytes) {
          const error = new Error(`text response exceeded cap ${maxBytes} bytes from ${url}`);
          await reader.cancel(error).catch(() => undefined);
          throw error;
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  } finally {
    clearTimeout(timer);
  }
}

export interface DownloadOptions {
  url: string;
  destPath: string;
  maxBytes: number;
  idleTimeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (received: number, total: number) => void;
}

// Download a URL to destPath. The idle watchdog aborts if no bytes arrive within
// idleTimeoutMs (covers a stalled connect and a stalled transfer); the byte cap
// aborts if the response advertises or streams more than maxBytes.
export async function downloadToFile(opts: DownloadOptions): Promise<void> {
  assertHttps(opts.url);
  const idleTimeoutMs = opts.idleTimeoutMs ?? 120_000;
  const controller = new AbortController();
  const combinedSignal = opts.signal
    ? AbortSignal.any([controller.signal, opts.signal])
    : controller.signal;
  let idle: ReturnType<typeof setTimeout> | null = null;
  const kick = (): void => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(
      () => controller.abort(new Error(`download stalled (> ${idleTimeoutMs}ms) for ${opts.url}`)),
      idleTimeoutMs,
    );
  };

  kick();
  try {
    const res = await fetchFollowingHttpsRedirects(opts.url, {}, combinedSignal);
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status} ${res.statusText} from ${opts.url}`);
    }

    const total = Number(res.headers.get("content-length") ?? 0);
    if (total > opts.maxBytes) {
      throw new Error(`tool download too large: ${total} bytes > cap ${opts.maxBytes}`);
    }

    let received = 0;
    const source = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>);
    source.on("data", (chunk: Buffer) => {
      received += chunk.length;
      kick();
      if (received > opts.maxBytes) {
        controller.abort(new Error(`tool download exceeded cap ${opts.maxBytes} bytes for ${opts.url}`));
        return;
      }
      opts.onProgress?.(received, total);
    });

    const out: Writable = createWriteStream(opts.destPath);
    await pipeline(source, out, { signal: combinedSignal });
  } finally {
    if (idle) clearTimeout(idle);
  }
}
