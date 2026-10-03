// Launcher for measure-lines: seeds a disposable data folder under the OS temp
// folder, starts Electron on harness.mjs against it, and always removes the
// folder and every process it started, within a bound, however the run ends.
//
//   node scripts/measure-lines/run.mjs [--out <dir>] [--app <module.mjs>]

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const KILL_GRACE_MS = 5_000;
const RUN_TIMEOUT_MS = 300_000;

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const appModule = resolve(argument("--app", join(here, "mumbler.mjs")));
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
const outDir = resolve(argument("--out", join(tmpdir(), `measure-lines-${stamp}`)));
const target = await import(pathToFileURL(appModule).href);

for (const file of target.builtCheck ?? []) {
  if (!existsSync(file)) throw new Error(`${file} is missing; build the app first.`);
}

const workDir = await mkdtemp(join(tmpdir(), "measure-lines-work-"));
const dataDir = join(workDir, "data");
let child = null;
let server = null;

// A loopback endpoint that accepts every request and never answers, for an
// app whose provider endpoint is a setting: calls stay in flight, nothing
// leaves the machine.
async function startBlackHole() {
  const open = new Set();
  const http = createServer((request) => {
    open.add(request.socket);
    request.resume();
  });
  await new Promise((done) => http.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${http.address().port}`,
    close: () => new Promise((done) => {
      for (const socket of open) socket.destroy();
      http.closeAllConnections();
      http.close(() => done());
    }),
  };
}

function childEnv() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    // No real provider key and no dev-server redirect may reach the app.
    if (/_API_KEY$/i.test(name) || name === "ELECTRON_RENDERER_URL" || name === "ELECTRON_RUN_AS_NODE") delete env[name];
  }
  return {
    ...env,
    [target.dataDirEnv]: dataDir,
    MEASURE_LINES_APP: appModule,
    MEASURE_LINES_WORK: workDir,
    MEASURE_LINES_OUT: outDir,
  };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Ends Electron and all its helpers: the whole process group on POSIX, the
// process tree on Windows; a forced kill follows the grace period.
async function stopChild() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { timeout: KILL_GRACE_MS });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + KILL_GRACE_MS;
  while (alive(-pid) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100));
  if (alive(-pid)) process.kill(-pid, "SIGKILL");
}

async function cleanUp() {
  await stopChild();
  await server?.close();
  await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void cleanUp().finally(() => process.exit(130));
  });
}

let ok = false;
try {
  await mkdir(dataDir, { recursive: true });
  server = await startBlackHole();
  await target.seed({ dataDir, blackHoleUrl: server.url });

  const electron = createRequire(join(here, "..", "..", "package.json"))("electron");
  child = spawn(electron, [join(here, "harness.mjs")], {
    env: childEnv(),
    stdio: ["ignore", "inherit", "inherit"],
    detached: process.platform !== "win32",
  });
  const exited = new Promise((done) => child.once("exit", done));
  const timedOut = new Promise((done) => setTimeout(() => done("timeout"), RUN_TIMEOUT_MS).unref());
  if ((await Promise.race([exited, timedOut])) === "timeout") {
    console.error(`[measure-lines] Electron did not exit within ${RUN_TIMEOUT_MS} ms; stopping it.`);
  }

  const result = JSON.parse(await readFile(join(workDir, "result.json"), "utf8").catch(() => '{"ok":false,"error":"no result"}'));
  ok = result.ok;
} finally {
  await cleanUp();
}

if (ok) {
  console.log(`[measure-lines] Output: ${outDir}`);
} else {
  console.error(`[measure-lines] Failed; partial output (if any): ${outDir}`);
  process.exitCode = 1;
}
