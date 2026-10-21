import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type LockedPackage = { resolved?: string; version?: string; hasInstallScript?: boolean };
type Lockfile = { packages: Record<string, LockedPackage> };

// npm matches registry approvals against the resolved tarball, not the install
// location or the package's claimed name/version. Keep this guard fail-closed
// when the lockfile introduces a source outside the current stable registry policy.
function registryIdentity(pkg: LockedPackage): string | undefined {
  if (!pkg.resolved) return undefined;
  const url = new URL(pkg.resolved);
  if (url.origin !== "https://registry.npmjs.org") return undefined;
  const match = /^\/((?:@[^/]+\/)?([^/]+))\/-\/([^/]+)\.tgz$/.exec(decodeURIComponent(url.pathname));
  if (!match || !match[3]!.startsWith(`${match[2]}-`)) return undefined;
  const version = match[3]!.slice(match[2]!.length + 1);
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) return undefined;
  if (version !== pkg.version) return undefined;
  return `${match[1]}@${version}`;
}

function policyProblems(policy: Record<string, unknown>, lock: Lockfile): string[] {
  const identities = new Set<string>();
  const problems: string[] = [];
  for (const [location, pkg] of Object.entries(lock.packages)) {
    if (!location) continue;
    const identity = registryIdentity(pkg);
    if (identity) identities.add(identity);
    if (pkg.hasInstallScript && (!identity || typeof policy[identity] !== "boolean")) {
      problems.push(`Unreviewed install script: ${location}`);
    }
  }
  for (const [identity, decision] of Object.entries(policy)) {
    if (!identities.has(identity)) problems.push(`Approval is not an exact locked identity: ${identity}`);
    if (typeof decision !== "boolean") problems.push(`Decision must be boolean: ${identity}`);
  }
  return problems;
}

const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

describe("install script policy", () => {
  it("reviews every locked install script with an exact, current identity", () => {
    expect(policyProblems(readJson("../../package.json").allowScripts, readJson("../../package-lock.json"))).toEqual([]);
  });

  const lock: Lockfile = { packages: {
    "": { version: "1.0.0" },
    "node_modules/alias": { version: "1.2.3", resolved: "https://registry.npmjs.org/@scope/tool/-/tool-1.2.3.tgz", hasInstallScript: true },
    "node_modules/parent/node_modules/tool": { version: "2.0.0", resolved: "https://registry.npmjs.org/tool/-/tool-2.0.0.tgz", hasInstallScript: true },
  } };
  const policy = { "@scope/tool@1.2.3": false, "tool@2.0.0": true };

  it("accepts explicit denials and nested/scoped resolved identities", () => {
    expect(policyProblems(policy, lock)).toEqual([]);
  });

  it.each(["tool", "tool@^2.0.0", "tool@1.0.0", "alias@1.2.3"])("rejects a broad, stale, or location-based approval: %s", (identity) => {
    expect(policyProblems({ ...policy, [identity]: true }, lock)).toContain(`Approval is not an exact locked identity: ${identity}`);
  });

  it("rejects a missing or nonboolean decision", () => {
    expect(policyProblems({ "@scope/tool@1.2.3": false }, lock)).toContain("Unreviewed install script: node_modules/parent/node_modules/tool");
    expect(policyProblems({ ...policy, "tool@2.0.0": "true" }, lock)).toContain("Decision must be boolean: tool@2.0.0");
  });

  it("does not let a claimed version authorize a different resolved tarball", () => {
    const changed = structuredClone(lock);
    changed.packages["node_modules/parent/node_modules/tool"]!.resolved = "https://registry.npmjs.org/tool/-/tool-3.0.0.tgz";
    expect(policyProblems(policy, changed)).toContain("Unreviewed install script: node_modules/parent/node_modules/tool");
  });

  it("requires review when the resolved source is missing or changes package name", () => {
    for (const resolved of [undefined, "https://registry.npmjs.org/other/-/other-2.0.0.tgz", "https://example.com/tool/-/tool-2.0.0.tgz"]) {
      const changed = structuredClone(lock);
      changed.packages["node_modules/parent/node_modules/tool"]!.resolved = resolved;
      expect(policyProblems(policy, changed)).toContain("Unreviewed install script: node_modules/parent/node_modules/tool");
    }
  });
});
