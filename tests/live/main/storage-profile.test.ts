// Full-lane native qualification of pre-ready path setup and retained lock ownership.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
let root: string;
const children: ChildProcess[] = [];
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "mumbler-native-profile-"));
  await mkdir(join(root, "lock"));
  await build({ configFile: false, logLevel: "silent", build: {
    target: "node22", outDir: join(root, "build"),
    ssr: fileURLToPath(new URL("../../fixtures/storage-profile/main.ts", import.meta.url)),
    rollupOptions: { external: ["electron"], output: { entryFileNames: "main.mjs" } },
  } });
});
afterAll(async () => {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await exited;
    clearTimeout(force);
  }
  await rm(root, { recursive: true, force: true });
});
async function launch(home: string) {
  const electron = (await import("electron")).default as unknown as string;
  const env: NodeJS.ProcessEnv = { ...process.env, MUMBLER_DATA_DIR: home };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [join(root, "build", "main.mjs"), `--user-data-dir=${join(root, "lock")}`], { env, stdio: "pipe" });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  await vi.waitFor(() => {
    if (child.exitCode !== null && !stdout.includes("\n")) throw new Error(stderr);
    expect(stdout).toContain("\n");
  }, { timeout: 30_000 });
  return { child, result: JSON.parse(stdout.split("\n")[0]!) as Record<string, unknown> };
}
it("redirects both paths before ready while retaining the original single-instance lock", async () => {
  const home = join(root, "data");
  const first = await launch(home);
  expect(first.result).toEqual({ kind: "ready", beforeReady: true, firstRun: true, userData: join(home, "electron"), sessionData: join(home, "electron") });
  const second = await launch(join(root, "other-data"));
  expect(second.result).toEqual({ kind: "excluded" });
  const exited = once(first.child, "exit");
  first.child.stdin!.write("close\n");
  await exited;
  const badRoot = join(root, "not-a-directory");
  await writeFile(badRoot, "keep");
  const failed = await launch(badRoot);
  expect(failed.result.kind).toBe("failed");
  expect(await readFile(badRoot, "utf8")).toBe("keep");
});
