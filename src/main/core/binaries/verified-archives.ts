import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { downloadToFile } from "./http";
import { verifySha256 } from "./integrity";
import { TOOL_DOWNLOAD_MAX_BYTES } from "./registry";

type Progress = (received: number, total: number) => void;
interface Archive {
  controller: AbortController;
  consumers: Set<Progress>;
  done: Promise<string>;
  ready: boolean;
}

/** The two Windows tools share a release archive, retained only in this
 * manager's session and the app-owned disposable temp tree. */
export class VerifiedArchives {
  private readonly entries = new Map<string, Archive>();
  constructor(private readonly directory: string) {}

  async acquire(url: string, sha256: string, signal: AbortSignal, progress: Progress): Promise<{ path: string; release: () => void }> {
    signal.throwIfAborted();
    const key = JSON.stringify([url, sha256]);
    let archive = this.entries.get(key);
    if (archive === undefined) {
      archive = { controller: new AbortController(), consumers: new Set(), done: Promise.resolve(""), ready: false };
      this.entries.set(key, archive);
      archive.done = this.prepare(key, archive, url, sha256);
    }
    const owned = archive;
    owned.consumers.add(progress);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      owned.consumers.delete(progress);
      if (!owned.ready && owned.consumers.size === 0) {
        owned.controller.abort();
        if (this.entries.get(key) === owned) this.entries.delete(key);
      }
    };
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => {
        release();
        // The last consumer owns physical settlement before giving its install
        // slot back. Other consumers can keep their shared download running.
        if (owned.controller.signal.aborted) void owned.done.then(() => reject(signal.reason), () => reject(signal.reason));
        else reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      const path = await Promise.race([owned.done, cancelled]);
      signal.throwIfAborted();
      return { path, release };
    } catch (error) {
      release();
      throw error;
    } finally { signal.removeEventListener("abort", abort); }
  }

  private async prepare(key: string, archive: Archive, url: string, sha256: string): Promise<string> {
    const path = join(this.directory, `tools-${nanoid()}.zip`);
    try {
      await mkdir(this.directory, { recursive: true });
      await downloadToFile({ url, destPath: path, maxBytes: TOOL_DOWNLOAD_MAX_BYTES, signal: archive.controller.signal,
        onProgress: (received, total) => { for (const notify of archive.consumers) notify(received, total); },
      });
      await verifySha256(path, sha256, archive.controller.signal);
      archive.controller.signal.throwIfAborted();
      archive.ready = true;
      return path;
    } catch (error) {
      if (this.entries.get(key) === archive) this.entries.delete(key);
      await rm(path, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
