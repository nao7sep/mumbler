interface WaveformWork {
  file: string;
  controller: AbortController;
  done: Promise<Float32Array>;
  requests: Set<string>;
}

/** The waveform of the one recording on screen. A request for the recording
 * already decoding joins that decode; a request for another recording, or the
 * release of a request by its id (even after its card was removed), aborts it.
 * The summary is held only while its player uses it. */
export class WaveformCache {
  private current: WaveformWork | null = null;
  private closed = false;

  constructor(private readonly compute: (file: string, signal: AbortSignal) => Promise<Float32Array>) {}

  async acquire(file: string, requestId: string): Promise<Float32Array | null> {
    if (this.closed) return null;
    if (this.current?.file !== file) {
      this.current?.controller.abort();
      const controller = new AbortController();
      this.current = { file, controller, done: this.compute(file, controller.signal), requests: new Set() };
    }
    const work = this.current;
    work.requests.add(requestId);
    try {
      const peaks = await work.done;
      return work.controller.signal.aborted ? null : peaks;
    } catch (error) {
      if (work.controller.signal.aborted) return null;
      throw error;
    }
  }

  release(requestId: string): void {
    if (this.current === null || !this.current.requests.has(requestId)) return;
    this.current.controller.abort();
    this.current = null;
  }

  async close(): Promise<void> {
    this.closed = true;
    const work = this.current;
    this.current = null;
    work?.controller.abort();
    await work?.done.catch(() => undefined);
  }
}
