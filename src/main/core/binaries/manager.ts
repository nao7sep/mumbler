import { execFile } from "node:child_process";
import { access, chmod, constants, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { nanoid } from "nanoid";

import type { DependencyStatus, ToolFacts, ToolName, ToolTransient } from "@shared/app-shell";
import { deriveStatus } from "@shared/dependency-status";

import type { AppLogger } from "../logger";
import type { JsonStore } from "../json-store";
import { OperationError } from "../operation-error";
import { assertArm64Slice } from "./arch";
import { extractFileFromZip } from "./archive";
import { downloadToFile, fetchText } from "./http";
import { parseSha256Sidecar, verifySha256 } from "./integrity";
import { afterCheckSuccess, afterInstall } from "./transitions";
import { TOOL_DOWNLOAD_MAX_BYTES, TOOL_NAMES, resolveLatest, toolFileName } from "./registry";
import type { DependenciesValue, PersistedToolFacts } from "./store";

const execFileAsync = promisify(execFile);

// Both audio tools are required for mumbler to function (ffprobe at import/probe
// and trim analysis, ffmpeg at trim/save).
const REQUIRED = true;

// Orchestrates the managed audio tools: their persisted facts, the scanned on-disk
// presence, the transient status of an in-flight operation, and the two operations
// — provision (Install/Update: acquire the latest and verify it once) and check
// (resolve the latest version for the set). It is the only writer of dependency
// state; the runtime reads `listStatuses()` for the snapshot and is notified to
// re-emit it as state changes.
export class ToolManager {
  // Presence is scanned once at startup (reconcile), not per render — a tool
  // deleted out of band mid-session is noticed at the next launch. The window is a
  // deliberate, documented trade (matches the fleet's other managed-dependency
  // apps) against probing the filesystem on every status read.
  private readonly present = new Map<ToolName, boolean>();
  private readonly transient = new Map<ToolName, ToolTransient>();
  private readonly busy = new Set<ToolName>();

  constructor(
    private readonly deps: {
      binDir: string;
      tempDir: string;
      platform: string;
      arch: string;
      value: DependenciesValue;
      store: JsonStore<DependenciesValue>;
      logger: AppLogger;
      notify: () => void;
    },
  ) {
    for (const name of TOOL_NAMES) {
      this.present.set(name, false);
      this.transient.set(name, { kind: "idle" });
    }
  }

  // Reconcile persisted facts against disk once at startup: a tool is present only
  // if its executable actually exists. Everything after reads these facts, so
  // rendering never probes the filesystem.
  async reconcile(): Promise<void> {
    for (const name of TOOL_NAMES) {
      this.present.set(name, await this.fileExists(this.toolPath(name)));
    }
  }

  toolPath(name: ToolName): string {
    return join(this.deps.binDir, toolFileName(name, this.deps.platform));
  }

  // Resolve a usable tool path, or throw a user-facing error pointing at the
  // management surface. Called by audio-tools at each ffmpeg/ffprobe invocation.
  resolveToolPath(name: ToolName): string {
    if (!(this.present.get(name) ?? false)) {
      throw new OperationError(
        `${name} is not installed. Open Audio Tools to install the required audio tools.`,
      );
    }
    return this.toolPath(name);
  }

  private factsOf(name: ToolName): ToolFacts {
    const persisted = this.deps.value.tools[name];
    return {
      present: this.present.get(name) ?? false,
      installedVersion: persisted.installedVersion,
      desiredVersion: persisted.desiredVersion,
      lastCheckedAtUtc: persisted.lastCheckedAtUtc,
    };
  }

  listStatuses(): DependencyStatus[] {
    return TOOL_NAMES.map((name) =>
      deriveStatus(name, REQUIRED, this.factsOf(name), this.transient.get(name) ?? { kind: "idle" }),
    );
  }

  // True when any tool has no successful check, or its last check is older than
  // maxAgeMs — the staleness gate for the startup update check.
  checkIsStale(maxAgeMs: number): boolean {
    const now = Date.now();
    return TOOL_NAMES.some((name) => {
      const last = this.deps.value.tools[name].lastCheckedAtUtc;
      return last === null || now - last > maxAgeMs;
    });
  }

  // The single acquire operation: download the latest build, verify it once, and
  // publish it atomically. Install and Update are the same flow — a fresh verified
  // copy replaces whatever was there. A bad download is discarded, never kept, so
  // there is no broken-installed state to repair.
  async installTool(name: ToolName): Promise<void> {
    if (this.busy.has(name)) {
      throw new OperationError(`${name} is already being installed.`);
    }
    this.busy.add(name);
    this.setTransient(name, { kind: "running", operation: "provision", percent: null });
    try {
      const resolved = await resolveLatest(this.deps.platform, this.deps.arch);
      const spec = resolved.tools[name];

      const sidecar = await fetchText(spec.sha256Url);
      const expected = parseSha256Sidecar(sidecar, spec.sha256AssetName);
      if (!expected) {
        throw new Error(`checksum for ${spec.sha256AssetName} not found at ${spec.sha256Url}`);
      }

      await mkdir(this.deps.tempDir, { recursive: true });
      await mkdir(this.deps.binDir, { recursive: true });
      // Both the downloaded archive and the extracted binary stage in temp/ under
      // unique (nanoid) names — temp/ holds everything disposable, so bin/ only
      // ever contains published binaries. temp/ and bin/ share the data root (one
      // filesystem), so the publish stays a true atomic rename, not a cross-volume
      // copy.
      const token = nanoid();
      const archivePath = join(this.deps.tempDir, `${name}-${token}.zip`);
      const stagedExe = join(this.deps.tempDir, `${name}-${token}.tmp`);

      try {
        await downloadToFile({
          url: spec.downloadUrl,
          destPath: archivePath,
          maxBytes: TOOL_DOWNLOAD_MAX_BYTES,
          onProgress: (received, total) => {
            const percent = total > 0 ? Math.floor((received / total) * 100) : null;
            this.setTransient(name, { kind: "running", operation: "provision", percent });
          },
        });
        // Integrity gate: verify the downloaded archive before it becomes
        // executable. A mismatch throws and aborts the install.
        await verifySha256(archivePath, expected);
        await extractFileFromZip(archivePath, spec.innerName, stagedExe);
        if (this.deps.platform === "darwin") {
          // Architecture gate: reject an x86_64-only build before it is published,
          // so a wrong-arch download fails clean here rather than at exec time on
          // Apple Silicon (no Rosetta).
          await assertArm64Slice(stagedExe);
        }
        if (this.deps.platform !== "win32") {
          await chmod(stagedExe, 0o755);
          if (this.deps.platform === "darwin") {
            await execFileAsync("xattr", ["-d", "com.apple.quarantine", stagedExe]).catch(() => undefined);
          }
        }
        // Publish with a single rename so the final path is only ever the complete,
        // executable binary — never mid-extract.
        await rename(stagedExe, this.toolPath(name));
      } finally {
        await rm(archivePath, { force: true }).catch(() => undefined);
        await rm(stagedExe, { force: true }).catch(() => undefined);
      }

      this.present.set(name, true);
      await this.mutate(name, (facts) => afterInstall(facts, resolved.version, Date.now()));
      await this.deps.logger.info("tools.installed", "Installed audio tool.", {
        tool: name,
        version: resolved.version,
      });
      this.setTransient(name, { kind: "idle" });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      // A failed install is transient (managed-runtime-dependencies-conventions):
      // the existing install, if any, is untouched — we only ever rename a fully
      // verified staging file into place — so the error lives in the transient
      // overlay, never the persisted facts. setTransient notifies the renderer.
      await this.deps.logger.warn("tools.install-failed", "Audio tool install failed.", {
        tool: name,
        error: message,
      });
      this.setTransient(name, { kind: "failed", operation: "provision", error: message });
    } finally {
      this.busy.delete(name);
    }
  }

  // Resolve the latest upstream version for the tool family and record it as the
  // desired version (→ up-to-date / update-available). A failed check is honest in
  // the data: it writes NOTHING (the displayed wording stays at the last
  // successful knowledge), logs the failure, and rethrows so an explicit Check can
  // show a transient "couldn't check" notice. It never blocks and never persists.
  async checkTools(): Promise<void> {
    // Never disturb a tool that is mid-install: its provision transient and
    // progress must survive a concurrent check. Only the tools idle at the start
    // get the running:check overlay; their facts are still recorded for all (a
    // successful install overwrites its own facts anyway).
    const overlaid = TOOL_NAMES.filter((name) => !this.busy.has(name));
    for (const name of overlaid) {
      this.setTransient(name, { kind: "running", operation: "check", percent: null });
    }
    try {
      const resolved = await resolveLatest(this.deps.platform, this.deps.arch);
      const now = Date.now();
      for (const name of TOOL_NAMES) {
        await this.mutate(name, (facts) => afterCheckSuccess(facts, resolved.version, now));
      }
      await this.deps.logger.info("tools.checked", "Checked audio tool updates.", {
        latest: resolved.version,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.deps.logger.warn("tools.check-failed", "Audio tool update check failed.", {
        error: message,
      });
      throw error instanceof Error ? error : new Error(message);
    } finally {
      // Clear only the overlays we set, and only if an install has not since
      // claimed the tool (which now owns its transient).
      for (const name of overlaid) {
        if (!this.busy.has(name)) {
          this.setTransient(name, { kind: "idle" });
        }
      }
    }
  }

  private setTransient(name: ToolName, transient: ToolTransient): void {
    this.transient.set(name, transient);
    this.deps.notify();
  }

  private async mutate(
    name: ToolName,
    update: (facts: PersistedToolFacts) => PersistedToolFacts,
  ): Promise<void> {
    this.deps.value.tools[name] = update(this.deps.value.tools[name]);
    await this.deps.store.save(this.deps.value);
    this.deps.notify();
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await access(path, constants.F_OK);
      const info = await stat(path);
      return info.isFile() && info.size > 0;
    } catch {
      return false;
    }
  }
}
