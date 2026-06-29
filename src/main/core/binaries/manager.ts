import { execFile } from "node:child_process";
import { access, chmod, constants, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type {
  DependencyStatus,
  ToolFacts,
  ToolName,
  ToolOperationKind,
  ToolTransient,
} from "@shared/app-shell";
import { deriveStatus } from "@shared/dependency-status";

import type { AppLogger } from "../logger";
import type { JsonStore } from "../json-store";
import { OperationError } from "../operation-error";
import { extractFileFromZip } from "./archive";
import { downloadToFile, fetchText } from "./http";
import { parseSha256Sidecar, sha256OfFile, verifySha256 } from "./integrity";
import {
  afterCheckFailure,
  afterCheckSuccess,
  afterInstall,
  afterVerifyFail,
  afterVerifyPass,
} from "./transitions";
import {
  TOOL_DOWNLOAD_MAX_BYTES,
  TOOL_NAMES,
  resolveLatest,
  toolFileName,
} from "./registry";
import type { DependenciesValue, PersistedToolFacts } from "./store";

const execFileAsync = promisify(execFile);

// Both audio tools are required for mumbler to function (ffprobe at import/probe
// and trim analysis, ffmpeg at trim/save).
const REQUIRED = true;

// Orchestrates the managed audio tools: their persisted facts, the reconciled
// on-disk presence, the transient status of an in-flight operation, and the four
// operations (provision / check / update / verify-repair). It is the only writer
// of dependency state; the runtime reads `listStatuses()` for the snapshot and is
// notified to re-emit it as state changes.
export class ToolManager {
  private readonly present = new Map<ToolName, boolean>();
  private readonly transient = new Map<ToolName, ToolTransient>();
  private readonly busy = new Set<ToolName>();

  constructor(
    private readonly deps: {
      binDir: string;
      downloadsDir: string;
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
    const facts = this.factsOf(name);
    if (!facts.present || facts.faulted) {
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
      faulted: persisted.faulted,
      installedVersion: persisted.installedVersion,
      desiredVersion: persisted.desiredVersion,
      lastCheckedAtUtc: persisted.lastCheckedAtUtc,
      lastCheckError: persisted.lastCheckError,
      lastError: persisted.lastError,
      hasInstalledChecksum: persisted.installedSha256 !== null,
    };
  }

  listStatuses(): DependencyStatus[] {
    return TOOL_NAMES.map((name) =>
      deriveStatus(name, REQUIRED, this.factsOf(name), this.transient.get(name) ?? { kind: "idle" }),
    );
  }

  // Any required tool that is absent — drives the blocking surface and the
  // startup auto-download.
  missingRequired(): ToolName[] {
    return TOOL_NAMES.filter((name) => !(this.present.get(name) ?? false));
  }

  // True when any tool has no successful check, or its last check is older than
  // maxAgeMs — the staleness gate for the startup currency check.
  checkIsStale(maxAgeMs: number): boolean {
    const now = Date.now();
    return TOOL_NAMES.some((name) => {
      const last = this.deps.value.tools[name].lastCheckedAtUtc;
      return last === null || now - last > maxAgeMs;
    });
  }

  // Provision / Update / Verify all share one atomic install flow; `operation`
  // only labels the transient status the surface shows.
  async installTool(name: ToolName, operation: ToolOperationKind): Promise<void> {
    if (this.busy.has(name)) {
      throw new OperationError(`${name} is already being installed.`);
    }
    this.busy.add(name);
    this.setTransient(name, { kind: "running", operation, percent: null });
    try {
      const resolved = await resolveLatest(this.deps.platform, this.deps.arch);
      const spec = resolved.tools[name];

      const sidecar = await fetchText(spec.sha256Url);
      const expected = parseSha256Sidecar(sidecar, spec.sha256AssetName);
      if (!expected) {
        throw new Error(`checksum for ${spec.sha256AssetName} not found at ${spec.sha256Url}`);
      }

      await mkdir(this.deps.downloadsDir, { recursive: true });
      await mkdir(this.deps.binDir, { recursive: true });
      const stamp = Date.now();
      const partial = join(this.deps.downloadsDir, `${name}-${stamp}.partial`);
      const staging = join(this.deps.binDir, `.${toolFileName(name, this.deps.platform)}.staging-${stamp}`);
      let installedSha256 = "";

      try {
        await downloadToFile({
          url: spec.downloadUrl,
          destPath: partial,
          maxBytes: TOOL_DOWNLOAD_MAX_BYTES,
          onProgress: (received, total) => {
            const percent = total > 0 ? Math.floor((received / total) * 100) : null;
            this.setTransient(name, { kind: "running", operation, percent });
          },
        });
        // Integrity gate: verify the downloaded archive before it becomes
        // executable. A mismatch throws and aborts the install.
        await verifySha256(partial, expected);
        await extractFileFromZip(partial, spec.innerName, staging);
        if (this.deps.platform !== "win32") {
          await chmod(staging, 0o755);
          if (this.deps.platform === "darwin") {
            await execFileAsync("xattr", ["-d", "com.apple.quarantine", staging]).catch(() => undefined);
          }
        }
        // Record the installed executable's own hash before publishing, so a later
        // Verify can re-hash the on-disk file and detect post-install corruption.
        installedSha256 = await sha256OfFile(staging);
        // Publish with a single rename so the final path is only ever the complete,
        // executable binary — never mid-extract.
        await rename(staging, this.toolPath(name));
      } finally {
        await rm(partial, { force: true }).catch(() => undefined);
        await rm(staging, { force: true }).catch(() => undefined);
      }

      this.present.set(name, true);
      await this.mutate(name, (facts) => afterInstall(facts, resolved.version, installedSha256, Date.now()));
      await this.deps.logger.info("tools.installed", "Installed audio tool.", {
        tool: name,
        version: resolved.version,
        operation,
      });
      this.setTransient(name, { kind: "idle" });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      // A failed install is transient (managed-dependency-status conventions, I6):
      // the existing install, if any, is untouched — we only ever rename a fully
      // verified staging file into place — so the error lives in the transient
      // overlay, never the persisted facts. setTransient notifies the renderer.
      await this.deps.logger.warn("tools.install-failed", "Audio tool install failed.", {
        tool: name,
        operation,
        error: message,
      });
      this.setTransient(name, { kind: "failed", operation, error: message });
    } finally {
      this.busy.delete(name);
    }
  }

  // Resolve the latest upstream version for the tool family and record it as the
  // desired version (→ current/stale). A failure is recorded honestly as
  // check-failed, never silently dropped, and never throws.
  async checkTools(): Promise<void> {
    for (const name of TOOL_NAMES) {
      this.setTransient(name, { kind: "running", operation: "check", percent: null });
    }
    const now = Date.now();
    try {
      const resolved = await resolveLatest(this.deps.platform, this.deps.arch);
      for (const name of TOOL_NAMES) {
        await this.mutate(name, (facts) => afterCheckSuccess(facts, resolved.version, now));
      }
      await this.deps.logger.info("tools.checked", "Checked audio tool updates.", {
        latest: resolved.version,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      for (const name of TOOL_NAMES) {
        await this.mutate(name, (facts) => afterCheckFailure(facts, message, now));
      }
      await this.deps.logger.warn("tools.check-failed", "Audio tool update check failed.", {
        error: message,
      });
    } finally {
      for (const name of TOOL_NAMES) {
        this.setTransient(name, { kind: "idle" });
      }
    }
  }

  // Verify: re-hash the installed file against the checksum recorded at install
  // and fault it on mismatch (the sole entry into Faulted). It never downloads —
  // a missing tool, or one with no recorded hash, has nothing to verify and is
  // handled by Reinstall instead (the button is disabled there; this guard is the
  // defensive backstop). Re-verifying a faulted tool is allowed: if its file was
  // restored out of band the re-hash clears the fault.
  async verifyTool(name: ToolName): Promise<void> {
    const expected = this.deps.value.tools[name].installedSha256;
    if (!(this.present.get(name) ?? false) || expected === null) {
      throw new OperationError(`${name} is not installed; nothing to verify. Use Reinstall.`);
    }

    if (this.busy.has(name)) {
      throw new OperationError(`${name} is already being processed.`);
    }
    this.busy.add(name);
    this.setTransient(name, { kind: "running", operation: "verify", percent: null });
    try {
      const path = this.toolPath(name);
      let actual: string;
      try {
        actual = await sha256OfFile(path);
      } catch {
        // The file vanished or became unreadable mid-verify — reconcile presence
        // (it becomes Absent if gone) rather than faulting a file that isn't there.
        this.present.set(name, await this.fileExists(path));
        this.setTransient(name, { kind: "idle" });
        return;
      }
      if (actual === expected) {
        await this.mutate(name, (facts) => afterVerifyPass(facts));
        await this.deps.logger.info("tools.verified", "Audio tool integrity verified.", { tool: name });
      } else {
        const message = `installed file failed integrity (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`;
        await this.mutate(name, (facts) => afterVerifyFail(facts, message));
        await this.deps.logger.warn("tools.verify-failed", "Audio tool integrity check failed.", {
          tool: name,
          error: message,
        });
      }
      this.setTransient(name, { kind: "idle" });
    } finally {
      this.busy.delete(name);
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
