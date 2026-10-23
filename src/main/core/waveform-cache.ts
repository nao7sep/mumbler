import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CancelledError } from "./cancellation";

interface WaveformWork {
  controller: AbortController;
  done: Promise<Float32Array>;
  consumers: number;
}

/** Working recordings are immutable and have unique paths. Disk summaries live
 * only in the app's disposable temp tree; memory belongs to active players. */
export class WaveformCache {
  private readonly byFile = new Map<string, WaveformWork>();
  private readonly requests = new Map<string, { work: WaveformWork; file: string }>();
  private readonly running = new Set<WaveformWork>();
  private closed = false;

  constructor(private readonly directory: string, private readonly compute: (file: string, signal: AbortSignal) => Promise<Float32Array>) {}

  async acquire(file: string, requestId: string): Promise<Float32Array | null> {
    if (this.closed) return null;
    if (this.requests.has(requestId)) throw new Error("Waveform request is already active.");
    let work = this.byFile.get(file);
    if (work === undefined) {
      const controller = new AbortController();
      work = { controller, done: this.load(file, controller.signal), consumers: 0 };
      this.byFile.set(file, work);
      this.running.add(work);
      const owned = work;
      void work.done.finally(() => this.running.delete(owned)).catch(() => undefined);
    }
    const request = { work, file };
    this.requests.set(requestId, request);
    work.consumers++;
    try {
      const peaks = await work.done;
      return this.requests.get(requestId) === request ? peaks : null;
    } catch (error) {
      if (work.controller.signal.aborted || this.requests.get(requestId) !== request) return null;
      throw error;
    }
  }

  release(requestId: string): void {
    const request = this.requests.get(requestId);
    if (request === undefined) return;
    this.requests.delete(requestId);
    if (--request.work.consumers === 0) {
      request.work.controller.abort();
      this.byFile.delete(request.file);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const requestId of this.requests.keys()) this.release(requestId);
    await Promise.allSettled([...this.running].map((work) => work.done));
  }

  private async load(file: string, signal: AbortSignal): Promise<Float32Array> {
    const cache = join(this.directory, `${createHash("sha256").update(file).digest("hex")}.f32`);
    try {
      const bytes = await readFile(cache, { signal });
      if (bytes.byteLength % 4 === 0) {
        const peaks = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        if (peaks.every((peak) => Number.isFinite(peak) && peak >= 0 && peak <= 1)) return peaks;
      }
    } catch { /* Disposable cache misses or failures fall through to decoding. */ }
    if (signal.aborted) throw new CancelledError();
    const peaks = await this.compute(file, signal);
    if (signal.aborted) throw new CancelledError();
    const stage = `${cache}.${randomUUID()}`;
    try {
      await mkdir(this.directory, { recursive: true });
      await writeFile(stage, Buffer.from(peaks.buffer, peaks.byteOffset, peaks.byteLength), { signal, mode: 0o600, flag: "wx" });
      if (!signal.aborted) await rename(stage, cache);
    } catch { /* The current player can still use its computed summary. */ }
    finally { await rm(stage, { force: true }).catch(() => undefined); }
    return peaks;
  }
}
