import { execFile } from "node:child_process";
import { access, chmod, constants, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { nanoid } from "nanoid";

import type { DependencyStatus, ToolFacts, ToolName, ToolTransient } from "@shared/app-shell";
import { deriveStatus } from "@shared/dependency-status";

import { syncDirectory, syncFile } from "../file-io";
import type { AppLogger } from "../logger";
import type { JsonStore } from "../json-store";
import { OperationError } from "../operation-error";
import { assertArm64Slice } from "./arch";
import { extractFileFromZip } from "./archive";
import { downloadToFile, fetchText } from "./http";
import {
  installedVersionSource,
  readInstalledVersion,
  writeVersionSidecar,
} from "./installed-version";
import { parseSha256Sidecar, verifySha256 } from "./integrity";
import { TOOL_DOWNLOAD_MAX_BYTES, TOOL_NAMES, resolveLatest, toolFileName } from "./registry";
import type { DependenciesValue, PersistedToolFacts } from "./store";

const execFileAsync = promisify(execFile);

// Both audio tools are required for mumbler to function (ffprobe at import/probe
// and trim analysis, ffmpeg at trim/save).
const REQUIRED = true;

// Orchestrates the managed audio tools: their persisted facts, the on-disk
// presence and installed version, the transient status of an in-flight operation,
// and the two operations — provision (Install/Update: acquire the latest and verify
// it once) and check (resolve the latest version for the set). It is the only
// writer of dependency state; the runtime reads `listStatuses()` for the snapshot
// and is notified to re-emit it as state changes.
export class ToolManager {
  // Presence AND the installed version are both read from the artifact once at
  // startup (reconcile), not per render — so the two can never disagree, and the
  // version probe (a subprocess spawn) never lands on a render path. A tool
  // changed out of band mid-session is noticed at the next launch; the window is a
  // deliberate, documented trade (matching the fleet's other managed-dependency
  // apps) against re-reading disk on every status read. An install refreshes both
  // for the tool it replaced.
  private readonly present = new Map<ToolName, boolean>();
  private readonly installedVersion = new Map<ToolName, string | null>();
  private readonly transient = new Map<ToolName, ToolTransient>();
  private readonly busy = new Set<ToolName>();
  private readonly installControllers = new Map<ToolName, AbortController>();
  private factsQueue: Promise<void> = Promise.resolve();

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
      this.installedVersion.set(name, null);
      this.transient.set(name, { kind: "idle" });
    }
  }

  // Read both artifact facts once at startup: a tool is present only if its
  // executable actually exists, and its installed version comes from that same
  // executable (or, on Windows, the sidecar written beside it). Everything after
  // reads what this recorded, so rendering never probes the filesystem or runs a
  // binary.
  async reconcile(): Promise<void> {
    // Concurrently: this sits on the awaited startup path, and the two tools'
    // probes are independent subprocesses.
    await Promise.all(TOOL_NAMES.map((name) => this.readFromDisk(name)));
  }

  // The one place the artifact is read. Presence first — an absent tool has no
  // version to read — then the version, from the source this platform uses. A
  // present tool whose version cannot be read is logged and left null: that is not
  // "absent" and never reads as up to date, and the surface offers the re-acquire
  // that fixes it.
  private async readFromDisk(name: ToolName): Promise<void> {
    const present = await this.fileExists(this.toolPath(name));
    this.present.set(name, present);
    if (!present) {
      this.installedVersion.set(name, null);
      return;
    }
    const version = await readInstalledVersion(
      name,
      this.toolPath(name),
      this.deps.binDir,
      installedVersionSource(this.deps.platform),
    );
    this.installedVersion.set(name, version);
    if (version === null) {
      await this.deps.logger.warn(
        "tools.version-unreadable",
        "Installed audio tool did not report a version.",
        { tool: name, path: this.toolPath(name) },
      );
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
      installedVersion: this.installedVersion.get(name) ?? null,
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
    const controller = new AbortController();
    this.installControllers.set(name, controller);
    let published = false;
    this.setTransient(name, { kind: "running", operation: "provision", percent: null });
    try {
      const resolved = await resolveLatest(this.deps.platform, this.deps.arch, controller.signal);
      const spec = resolved.tools[name];

      const sidecar = await fetchText(spec.sha256Url, {}, 30_000, controller.signal);
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
          signal: controller.signal,
          onProgress: (received, total) => {
            const percent = total > 0 ? Math.floor((received / total) * 100) : null;
            this.setTransient(name, { kind: "running", operation: "provision", percent });
          },
        });
        // Integrity gate: verify the downloaded archive before it becomes
        // executable. A mismatch throws and aborts the install.
        await verifySha256(archivePath, expected, controller.signal);
        await extractFileFromZip(archivePath, spec.innerName, stagedExe, controller.signal);
        if (this.deps.platform === "darwin") {
          // Architecture gate: reject an x86_64-only build before it is published,
          // so a wrong-arch download fails clean here rather than at exec time on
          // Apple Silicon (no Rosetta).
          await assertArm64Slice(stagedExe, controller.signal);
        }
        if (this.deps.platform !== "win32") {
          await chmod(stagedExe, 0o755);
          if (this.deps.platform === "darwin") {
            await execFileAsync("xattr", ["-d", "com.apple.quarantine", stagedExe], {
              signal: controller.signal,
              timeout: 30_000,
            }).catch((error: unknown) => {
              controller.signal.throwIfAborted();
              if (
                error instanceof Error &&
                "killed" in error &&
                (error as Error & { killed?: boolean }).killed
              ) {
                throw error;
              }
            });
          }
        }
        // Publish with a single rename so the final path is only ever the complete,
        // executable binary — never mid-extract.
        await syncFile(stagedExe);
        controller.signal.throwIfAborted();
        await rename(stagedExe, this.toolPath(name));
        published = true;
        await syncDirectory(this.deps.binDir);
      } finally {
        await rm(archivePath, { force: true }).catch(() => undefined);
        await rm(stagedExe, { force: true }).catch(() => undefined);
      }

      // The binary has landed. Where it cannot report its own version, record the
      // resolved one beside it — AFTER the publish, so a failure here leaves a
      // present tool reading version-unknown (which offers a re-acquire) rather
      // than an old binary wearing the new version's label.
      try {
        if (installedVersionSource(this.deps.platform).kind === "sidecar") {
          await writeVersionSidecar(this.deps.binDir, name, resolved.version, Date.now());
        }
      } finally {
        // Re-read the artifact even when the sidecar write fails: the binary in
        // bin/ IS the new one, and presence/version must describe it rather than
        // what was there before.
        await this.readFromDisk(name);
      }
      // Only the upstream fact is persisted. What is now installed is read back
      // from the binary, so an install has nothing to record about it.
      await this.mutateFacts((facts) => ({
        ...facts,
        [name]: {
          ...facts[name],
          desiredVersion: resolved.version,
          lastCheckedAtUtc: Date.now(),
        },
      }));
      await this.deps.logger.info("tools.installed", "Installed audio tool.", {
        tool: name,
        version: resolved.version,
      });
      this.setTransient(name, { kind: "idle" });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (controller.signal.aborted && !published) {
        await this.deps.logger.info("tools.install-cancelled", "Cancelled audio tool install.", {
          tool: name,
        });
        this.setTransient(name, { kind: "idle" });
        return;
      }
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
      if (this.installControllers.get(name) === controller) {
        this.installControllers.delete(name);
      }
    }
  }

  cancelInstall(name: ToolName): void {
    const controller = this.installControllers.get(name);
    if (controller && !controller.signal.aborted) {
      controller.abort(new Error(`${name} installation cancelled by user.`));
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
      await this.mutateFacts((facts) => ({
        ffmpeg: { ...facts.ffmpeg, desiredVersion: resolved.version, lastCheckedAtUtc: now },
        ffprobe: { ...facts.ffprobe, desiredVersion: resolved.version, lastCheckedAtUtc: now },
      }));
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

  // Compute, persist, and only then expose a complete facts replacement. Keeping
  // this manager-level queue means a concurrent install/check computes from the
  // last committed value rather than overwriting another operation's update with
  // a stale snapshot. A failed save applies nothing in memory and does not wedge
  // later writes.
  private async mutateFacts(
    update: (
      facts: Record<ToolName, PersistedToolFacts>,
    ) => Record<ToolName, PersistedToolFacts>,
  ): Promise<void> {
    const work = async (): Promise<void> => {
      const nextTools = update(this.deps.value.tools);
      const nextValue: DependenciesValue = {
        ...this.deps.value,
        tools: nextTools,
      };
      await this.deps.store.save(nextValue);
      this.deps.value.tools = nextTools;
      this.deps.notify();
    };
    const operation = this.factsQueue.then(work, work);
    this.factsQueue = operation.catch(() => undefined);
    await operation;
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
