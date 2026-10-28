interface WaveformWork {
  controller: AbortController;
  done: Promise<Float32Array>;
  consumers: number;
}

/** Players acquire a recording's summary by their own request id, so a player
 * that goes away, even after its card was removed, releases it and the last one
 * stops the decode. A summary is held only while a player uses it. */
export class WaveformCache {
  private readonly byFile = new Map<string, WaveformWork>();
  private readonly requests = new Map<string, { work: WaveformWork; file: string }>();
  private readonly running = new Set<WaveformWork>();
  private closed = false;

  constructor(private readonly compute: (file: string, signal: AbortSignal) => Promise<Float32Array>) {}

  async acquire(file: string, requestId: string): Promise<Float32Array | null> {
    if (this.closed) return null;
    if (this.requests.has(requestId)) throw new Error("Waveform request is already active.");
    let work = this.byFile.get(file);
    if (work === undefined) {
      const controller = new AbortController();
      work = { controller, done: this.compute(file, controller.signal), consumers: 0 };
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
}
