import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

// The launcher helper is plain ESM because both shell families execute it directly.
// @ts-expect-error The directly executed .mjs helper intentionally has no declaration file.
import { claimRuntime, isRuntimeOwner, ownsProcess, parsePosixProcesses, parseWindowsProcesses, releaseRuntime, REPO_ROOT } from "../../scripts/launcher-runtime.mjs";

// The process listings each platform's tool prints, read on every host; the
// native ps, PowerShell and taskkill calls run in the Windows live lane.
describe("launcher process listings", () => {
  it("reads ps output, skipping lines it cannot parse", () => {
    expect(parsePosixProcesses("  10     1 /Applications/Mumbler.app/Contents/MacOS/Mumbler --flag\n\nnot a row\n 11 10 ffmpeg -i in.m4a\n")).toEqual([
      { pid: 10, parentPid: 1, executablePath: "", commandLine: "/Applications/Mumbler.app/Contents/MacOS/Mumbler --flag" },
      { pid: 11, parentPid: 10, executablePath: "", commandLine: "ffmpeg -i in.m4a" },
    ]);
  });

  it("reads PowerShell's process list, a lone process and processes it cannot inspect", () => {
    expect(parseWindowsProcesses(JSON.stringify([
      { ProcessId: 20, ParentProcessId: 4, ExecutablePath: "C:\\Mumbler\\Mumbler.exe", CommandLine: "\"C:\\Mumbler\\Mumbler.exe\"" },
      { ProcessId: 4, ParentProcessId: 0, ExecutablePath: null, CommandLine: null },
    ]))).toEqual([
      { pid: 20, parentPid: 4, executablePath: "C:\\Mumbler\\Mumbler.exe", commandLine: "\"C:\\Mumbler\\Mumbler.exe\"" },
      { pid: 4, parentPid: 0, executablePath: "", commandLine: "" },
    ]);
    expect(parseWindowsProcesses(`${JSON.stringify({ ProcessId: 30, ParentProcessId: 20, ExecutablePath: "C:\\ffmpeg.exe", CommandLine: "ffmpeg" })}\r\n`)).toEqual([
      { pid: 30, parentPid: 20, executablePath: "C:\\ffmpeg.exe", commandLine: "ffmpeg" },
    ]);
    expect(parseWindowsProcesses("")).toEqual([]);
  });
});

describe("launcher process identity", () => {
  const identity = { kind: "electron", label: "Mumbler", executable: "Mumbler" };

  it("owns only this repository's Mumbler runtime", () => {
    expect(ownsProcess({
      pid: 10,
      parentPid: 1,
      executablePath: `${REPO_ROOT}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`,
      commandLine: "",
    }, identity)).toBe(true);
    expect(ownsProcess({
      pid: 11,
      parentPid: 1,
      executablePath: `${REPO_ROOT}/dist/mac-arm64/Mumbler.app/Contents/MacOS/Mumbler`,
      commandLine: "",
    }, identity)).toBe(true);
    expect(ownsProcess({
      pid: 12,
      parentPid: 1,
      executablePath: `${REPO_ROOT}\\dist\\win-unpacked\\Mumbler.exe`,
      commandLine: "",
    }, identity)).toBe(true);
    expect(ownsProcess({
      pid: 13,
      parentPid: 1,
      executablePath: "/another/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      commandLine: "",
    }, identity)).toBe(false);
  });

  it("does not let a stale launcher generation clean up its replacement", async () => {
    const first = `first-${randomUUID()}`;
    const second = `second-${randomUUID()}`;
    try {
      await claimRuntime(first);
      await claimRuntime(second);
      expect(await isRuntimeOwner(first)).toBe(false);
      expect(await isRuntimeOwner(second)).toBe(true);
    } finally {
      await releaseRuntime(second);
    }
  });
});

// The launchers find the running app by its product name, which the packaged
// bundle and executable take from electron-builder.yml.
describe("the launchers' app identity", () => {
  it("names the app as packaging does", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const productName = /^productName:\s*(.+)$/m.exec(readFileSync(join(REPO_ROOT, "electron-builder.yml"), "utf8"))?.[1]?.trim();
    expect(productName).toBeTruthy();
    const scripts = join(REPO_ROOT, "scripts");
    const identities = readdirSync(scripts).filter((name) => /\.(command|ps1)$/.test(name)).flatMap((name) =>
      [...readFileSync(join(scripts, name), "utf8").matchAll(/electron"?,?\s+"([^"]+)"[,\s]+"([^"]+)"/g)].map((match) => [name, match[1], match[2]]));
    expect(identities.length, "every launcher passes the identity").toBeGreaterThanOrEqual(6);
    for (const [name, label, executable] of identities) {
      expect([label, executable], name).toEqual([productName, productName]);
    }
  });
});
