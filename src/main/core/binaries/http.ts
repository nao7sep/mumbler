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

// Resolve a single redirect hop without following it — martin-riedl's
// `/redirect/latest/...` 307s to the versioned `/download/...` path, and that
// Location is both the download URL and the carrier of the version. Returns the
// absolute Location.
export async function resolveRedirectLocation(url: string, idleTimeoutMs = 30_000): Promise<string> {
  assertHttps(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out resolving ${url}`)), idleTimeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { method: "GET", redirect: "manual", signal: controller.signal });
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
  idleTimeoutMs = 30_000,
): Promise<string> {
  assertHttps(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out fetching ${url}`)), idleTimeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow", headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} from ${url}`);
  }
  return res.text();
}

export interface DownloadOptions {
  url: string;
  destPath: string;
  maxBytes: number;
  idleTimeoutMs?: number;
  onProgress?: (received: number, total: number) => void;
}

// Download a URL to destPath. The idle watchdog aborts if no bytes arrive within
// idleTimeoutMs (covers a stalled connect and a stalled transfer); the byte cap
// aborts if the response advertises or streams more than maxBytes.
export async function downloadToFile(opts: DownloadOptions): Promise<void> {
  assertHttps(opts.url);
  const idleTimeoutMs = opts.idleTimeoutMs ?? 120_000;
  const controller = new AbortController();
  let idle: ReturnType<typeof setTimeout> | null = null;
  const kick = (): void => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(
      () => controller.abort(new Error(`download stalled (> ${idleTimeoutMs}ms) for ${opts.url}`)),
      idleTimeoutMs,
    );
  };

  kick();
  let res: Response;
  try {
    res = await fetch(opts.url, { redirect: "follow", signal: controller.signal });
  } catch (error) {
    if (idle) clearTimeout(idle);
    throw error;
  }

  if (!res.ok || !res.body) {
    if (idle) clearTimeout(idle);
    throw new Error(`HTTP ${res.status} ${res.statusText} from ${opts.url}`);
  }

  const total = Number(res.headers.get("content-length") ?? 0);
  if (total > opts.maxBytes) {
    if (idle) clearTimeout(idle);
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
  try {
    await pipeline(source, out);
  } finally {
    if (idle) clearTimeout(idle);
  }
}
