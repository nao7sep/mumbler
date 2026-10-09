import semver from "semver";

import type { ReleaseCheckOutcome } from "@shared/app-shell";
import { RELEASE_REPOSITORY } from "@shared/release";

// Tells the user when a newer full release of Mumbler is on GitHub
// (github-release-check-conventions). Notification only: it never downloads,
// installs or opens anything by itself, and it is separate from the managed
// audio tools' update check, sharing none of its preference, time, command or
// state.

const LATEST_RELEASE_API = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`;
const REQUEST_TIMEOUT_MS = 10_000;
const LAUNCH_INTERVAL_MS = 24 * 60 * 60 * 1000;

// "skipped" is an automatic check that did not run: not due, turned off, or
// its attempt time could not be saved.
export type ReleaseCheckResult = ReleaseCheckOutcome;

/** The version a `vX.Y.Z` latest-release answer names; anything else is a failure. */
export function releaseVersionOf(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("The latest-release answer is not JSON.");
  }
  const tag = typeof parsed === "object" && parsed !== null ? (parsed as { tag_name?: unknown }).tag_name : undefined;
  const version = typeof tag === "string" && /^v\d/.test(tag) ? semver.valid(tag.slice(1)) : null;
  if (version === null) throw new Error("The latest-release answer names no vX.Y.Z tag.");
  return version;
}

/** A missing, invalid or future attempt time is due rather than suppressing checks. */
export function launchCheckDue(lastAttemptAtUtc: number | null, nowMs: number): boolean {
  return lastAttemptAtUtc === null || !Number.isFinite(lastAttemptAtUtc) || lastAttemptAtUtc > nowMs ||
    nowMs - lastAttemptAtUtc >= LAUNCH_INTERVAL_MS;
}

export interface ReleaseCheckDeps {
  installedVersion: string;
  /** Answers the latest-release request's body; rejects on any failure. */
  fetchLatest: (url: string, headers: Record<string, string>, timeoutMs: number) => Promise<string>;
  lastAttemptAtUtc: () => number | null;
  /** Saves the attempt time; rejects when it cannot. */
  saveAttemptAtUtc: (timeUtc: number) => Promise<void>;
  warn: (message: string, details: Record<string, unknown>) => void;
  now?: () => number;
}

// One request at a time per process: a manual check made while the launch
// check runs takes that check's result instead of starting another.
export class ReleaseChecker {
  private inFlight: Promise<ReleaseCheckResult> | null = null;
  // A manual check joined the running one: the manual failure policy applies.
  private manualJoined = false;

  constructor(private readonly deps: ReleaseCheckDeps) {}

  check(kind: "automatic" | "manual"): Promise<ReleaseCheckResult> {
    if (this.inFlight !== null) {
      if (kind === "manual") this.manualJoined = true;
      return this.inFlight;
    }
    this.manualJoined = kind === "manual";
    const now = (this.deps.now ?? Date.now)();
    if (kind === "automatic" && !launchCheckDue(this.deps.lastAttemptAtUtc(), now)) {
      return Promise.resolve({ kind: "skipped" });
    }
    const run = this.run(kind, now).finally(() => {
      if (this.inFlight === run) this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async run(kind: "automatic" | "manual", now: number): Promise<ReleaseCheckResult> {
    // Recorded before the request, so repeated offline launches stay throttled.
    try {
      await this.deps.saveAttemptAtUtc(now);
    } catch (error: unknown) {
      this.deps.warn("Could not record the release check attempt.", { error: errorText(error), kind });
      if (!this.manualJoined) return { kind: "skipped" };
    }
    try {
      const body = await this.deps.fetchLatest(LATEST_RELEASE_API, {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": `Mumbler/${this.deps.installedVersion}`,
      }, REQUEST_TIMEOUT_MS);
      const latest = releaseVersionOf(body);
      // A development build newer than the release is current, never offered a downgrade.
      return semver.gt(latest, this.deps.installedVersion)
        ? { kind: "newer", version: latest }
        : { kind: "current", version: this.deps.installedVersion };
    } catch (error: unknown) {
      this.deps.warn("Could not check GitHub for a new release.", { error: errorText(error), kind });
      return { kind: "failed" };
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
