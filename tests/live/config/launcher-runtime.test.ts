import { execFile, fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function terminate(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

// Uses native PowerShell/CIM and taskkill, including the launcher's shipped
// five-second force escalation. This external platform integration belongs in
// the existing live lane; no ordinary test timeout is raised to fit it.
describe.skipIf(process.platform !== "win32")("Windows launcher process ownership", () => {
  it("stops only its disposable runtime tree, and a stale owner cannot stop it", async () => {
    const root = await mkdtemp(join(tmpdir(), "mumbler-launcher-"));
    const app = join(root, "app");
    const scripts = join(app, "scripts");
    await mkdir(scripts, { recursive: true });
    const launcher = join(scripts, "launcher-runtime.mjs");
    // Unchanged source, isolated REPO_ROOT and owner file: even a running real
    // Mumbler cannot match this fixture's process identity or ownership token.
    await copyFile(new URL("../../../scripts/launcher-runtime.mjs", import.meta.url), launcher);
    const sleeper = join(root, "sleep.cjs");
    const parent = join(app, "parent.cjs");
    await writeFile(sleeper, "process.send?.(process.pid); setInterval(() => {}, 1000);\n");
    await writeFile(parent, [
      "const { fork } = require('node:child_process');",
      "const child = fork(process.argv[2], [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });",
      "child.once('message', pid => process.send({ parent: process.pid, child: pid }));",
      "setInterval(() => {}, 1000);",
    ].join("\n"));
    const identity = ["electron", "Disposable Mumbler", "fixture-runtime"];
    const run = (...args: string[]) => execFileAsync(process.execPath, [launcher, ...args], {
      timeout: 30_000,
      windowsHide: true,
    });
    let runtime: ChildProcess | undefined;
    let unrelated: ChildProcess | undefined;
    let grandchild: number | undefined;
    try {
      unrelated = fork(sleeper, [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
      const [unrelatedPid] = await once(unrelated, "message") as [number];
      runtime = fork(parent, [sleeper, join(app, "fixture-runtime.exe")], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      const [pids] = await once(runtime, "message") as [{ parent: number; child: number }];
      grandchild = pids.child;
      expect(pids.parent).toBe(runtime.pid);
      expect(alive(pids.child)).toBe(true);
      expect(alive(unrelatedPid)).toBe(true);

      await run("claim", "current-test-owner");
      await run("stop-if-owner", "stale-test-owner", ...identity);
      expect(alive(pids.parent)).toBe(true);
      expect(alive(pids.child)).toBe(true);

      await run("stop-if-owner", "current-test-owner", ...identity);
      expect(alive(pids.parent)).toBe(false);
      expect(alive(pids.child)).toBe(false);
      expect(alive(unrelatedPid)).toBe(true);
      await expect(run("is-owner", "current-test-owner")).rejects.toMatchObject({ code: 3 });
    } finally {
      // Cleanup addresses only captured children created by this test. Never
      // search for process names or use the developer's repository root.
      if (runtime?.pid && alive(runtime.pid)) {
        await execFileAsync("taskkill.exe", ["/PID", String(runtime.pid), "/T", "/F"], { timeout: 5_000 }).catch(() => undefined);
      }
      if (grandchild && alive(grandchild)) process.kill(grandchild, "SIGKILL");
      await terminate(runtime);
      await terminate(unrelated);
      await run("release-if-owner", "current-test-owner");
      await rm(root, { recursive: true, force: true });
    }
  });
});
