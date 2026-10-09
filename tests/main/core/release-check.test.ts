import { describe, expect, it, vi } from "vitest";

import { launchCheckDue, ReleaseChecker, releaseVersionOf, type ReleaseCheckDeps } from "@main/core/release-check";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);

function checker(overrides: Partial<ReleaseCheckDeps> = {}): { checker: ReleaseChecker; deps: ReleaseCheckDeps } {
  let attempt: number | null = null;
  const deps: ReleaseCheckDeps = {
    installedVersion: "0.1.0",
    fetchLatest: vi.fn(async () => JSON.stringify({ tag_name: "v0.2.0" })),
    lastAttemptAtUtc: () => attempt,
    saveAttemptAtUtc: vi.fn(async (time: number) => { attempt = time; }),
    warn: vi.fn(),
    now: () => NOW,
    ...overrides,
  };
  return { checker: new ReleaseChecker(deps), deps };
}

describe("reading the latest-release answer", () => {
  it("takes the version a vX.Y.Z tag names", () => {
    expect(releaseVersionOf(JSON.stringify({ tag_name: "v1.4.2", name: "ignored" }))).toBe("1.4.2");
  });

  it.each([
    ["not JSON", "<html>"],
    ["no tag", JSON.stringify({ name: "v1.0.0" })],
    ["a tag without v", JSON.stringify({ tag_name: "1.0.0" })],
    ["a tag that is not a version", JSON.stringify({ tag_name: "vnext" })],
  ])("refuses %s as a failure, never as up to date", (_case, body) => {
    expect(() => releaseVersionOf(body)).toThrow();
  });
});

describe("the launch interval", () => {
  it("is due with no attempt, an attempt a day old, or one in the future, and not within a day", () => {
    expect(launchCheckDue(null, NOW)).toBe(true);
    expect(launchCheckDue(NOW - DAY, NOW)).toBe(true);
    expect(launchCheckDue(NOW + 1000, NOW)).toBe(true);
    expect(launchCheckDue(NOW - DAY + 1000, NOW)).toBe(false);
  });
});

describe("a release check", () => {
  it("records the attempt before asking, sends the GitHub headers, and reports a newer release", async () => {
    const { checker: check, deps } = checker();
    await expect(check.check("automatic")).resolves.toEqual({ kind: "newer", version: "0.2.0" });
    expect(deps.saveAttemptAtUtc).toHaveBeenCalledWith(NOW);
    const [url, headers, timeout] = vi.mocked(deps.fetchLatest).mock.calls[0]!;
    expect(url).toBe("https://api.github.com/repos/nao7sep/mumbler/releases/latest");
    expect(headers).toEqual({ Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Mumbler/0.1.0" });
    expect(timeout).toBeLessThanOrEqual(10_000);
  });

  it("calls an equal release, and a development build newer than it, current", async () => {
    const same = checker({ fetchLatest: async () => JSON.stringify({ tag_name: "v0.1.0" }) });
    await expect(same.checker.check("manual")).resolves.toEqual({ kind: "current", version: "0.1.0" });
    const ahead = checker({ installedVersion: "0.3.0", fetchLatest: async () => JSON.stringify({ tag_name: "v0.2.0" }) });
    await expect(ahead.checker.check("manual")).resolves.toEqual({ kind: "current", version: "0.3.0" });
  });

  it("compares by semantic precedence, not as text", async () => {
    const { checker: check } = checker({ installedVersion: "0.9.0", fetchLatest: async () => JSON.stringify({ tag_name: "v0.10.0" }) });
    await expect(check.check("manual")).resolves.toEqual({ kind: "newer", version: "0.10.0" });
  });

  it("reports a failed request or an invalid answer as a failure and logs it", async () => {
    const offline = checker({ fetchLatest: async () => { throw new Error("offline"); } });
    await expect(offline.checker.check("manual")).resolves.toEqual({ kind: "failed" });
    expect(offline.deps.warn).toHaveBeenCalled();
    const invalid = checker({ fetchLatest: async () => "{}" });
    await expect(invalid.checker.check("manual")).resolves.toEqual({ kind: "failed" });
  });

  it("skips an automatic check within a day of the last attempt, while a manual one still asks", async () => {
    const { checker: check, deps } = checker({ lastAttemptAtUtc: () => NOW - 1000 });
    await expect(check.check("automatic")).resolves.toEqual({ kind: "skipped" });
    expect(deps.fetchLatest).not.toHaveBeenCalled();
    await expect(check.check("manual")).resolves.toEqual({ kind: "newer", version: "0.2.0" });
  });

  it("skips an automatic check whose attempt cannot be recorded, while a manual one goes ahead", async () => {
    const refusing = { saveAttemptAtUtc: vi.fn(async () => { throw new Error("disk full"); }) };
    const automatic = checker(refusing);
    await expect(automatic.checker.check("automatic")).resolves.toEqual({ kind: "skipped" });
    expect(automatic.deps.fetchLatest).not.toHaveBeenCalled();
    const manual = checker(refusing);
    await expect(manual.checker.check("manual")).resolves.toEqual({ kind: "newer", version: "0.2.0" });
  });

  it("sends one request at a time: a manual check during the launch check takes its result", async () => {
    let answer!: (body: string) => void;
    const { checker: check, deps } = checker({ fetchLatest: vi.fn(() => new Promise<string>((resolve) => { answer = resolve; })) });
    const automatic = check.check("automatic");
    const manual = check.check("manual");
    await vi.waitFor(() => expect(deps.fetchLatest).toHaveBeenCalledOnce());
    answer(JSON.stringify({ tag_name: "v0.2.0" }));
    await expect(automatic).resolves.toEqual({ kind: "newer", version: "0.2.0" });
    await expect(manual).resolves.toEqual({ kind: "newer", version: "0.2.0" });
  });

  it("lets a manual check that joined the launch check go ahead when the attempt cannot be recorded", async () => {
    let refuse!: (error: Error) => void;
    const { checker: check, deps } = checker({ saveAttemptAtUtc: () => new Promise<void>((_resolve, reject) => { refuse = reject; }) });
    const automatic = check.check("automatic");
    const manual = check.check("manual");
    refuse(new Error("disk full"));
    await expect(manual).resolves.toEqual({ kind: "newer", version: "0.2.0" });
    await expect(automatic).resolves.toEqual({ kind: "newer", version: "0.2.0" });
    expect(deps.fetchLatest).toHaveBeenCalledOnce();
  });
});
