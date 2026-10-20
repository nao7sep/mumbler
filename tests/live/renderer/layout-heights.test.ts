// The window minimums rest on three heights the layout produces rather than
// sets: the topbar block above the panes, the records window's filter band,
// and the detail stack's floor. This lane builds the app, runs it in Electron
// with its own data and profile folders (so a running Mumbler is left alone),
// and measures the rendered pages over the DevTools protocol.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DETAIL_MIN_HEIGHT, RECORDS_FILTERS_HEIGHT, TOPBAR_BLOCK } from "@shared/layout";

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const CACHE = join(REPO, "node_modules", ".cache", "mumbler-live");
// Inside the repository, so the built main process resolves its dependencies.
const BUILD = join(CACHE, "layout-out");

type Target = { type: string; url: string; webSocketDebuggerUrl: string };

/** Evaluates `expression` in one page over the DevTools protocol. */
async function evaluate<T>(target: Target, expression: string): Promise<T> {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, "open");
  try {
    socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
    for (;;) {
      const [event] = await once(socket, "message") as [MessageEvent<string>];
      const reply = JSON.parse(event.data) as { id?: number; result?: { result: { value: T }; exceptionDetails?: unknown } };
      if (reply.id !== 1) continue;
      if (reply.result?.exceptionDetails) throw new Error(`Evaluation failed: ${JSON.stringify(reply.result.exceptionDetails)}`);
      return reply.result!.result.value;
    }
  } finally {
    socket.close();
  }
}

let child: ChildProcess | undefined;
let folders: string[] = [];
let port = "";

async function page(file: string, ready: string): Promise<Target> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Target[];
    const target = targets.find((entry) => entry.type === "page" && entry.url.endsWith(file));
    if (target && await evaluate<boolean>(target, `document.querySelector(${JSON.stringify(ready)}) !== null`).catch(() => false)) return target;
    if (Date.now() > deadline) throw new Error(`${file} did not show ${ready} within 30 s.`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

beforeAll(async () => {
  await execFileAsync(process.execPath, [join(REPO, "node_modules", "electron-vite", "bin", "electron-vite.js"), "build", "--outDir", BUILD], { cwd: REPO });
  const home = await mkdtemp(join(CACHE, "layout-home-"));
  const profile = await mkdtemp(join(CACHE, "layout-profile-"));
  folders = [home, profile];
  const electron = (await import("electron")).default as unknown as string;
  child = spawn(electron, [join(BUILD, "main", "index.js"), `--user-data-dir=${profile}`, "--remote-debugging-port=0"], {
    env: { ...process.env, MUMBLER_DATA_DIR: home },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const deadline = Date.now() + 30_000;
  while (!/DevTools listening on ws:\/\/[^:]+:(\d+)/.test(stderr)) {
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`Electron did not open its DevTools port:\n${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  port = /DevTools listening on ws:\/\/[^:]+:(\d+)/.exec(stderr)![1]!;
});

afterAll(async () => {
  // Only the process this lane started, by its own handle.
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const forced = setTimeout(() => child?.kill("SIGKILL"), 5_000);
    await exited;
    clearTimeout(forced);
  }
  await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })));
});

describe("the heights the window minimums rest on", () => {
  it("reserves above the panes what the topbar takes", async () => {
    const main = await page("/renderer/index.html", ".topbar");
    const block = await evaluate<number>(main, `(() => {
      const topbar = document.querySelector(".topbar");
      return topbar.getBoundingClientRect().height + parseFloat(getComputedStyle(topbar).marginBottom);
    })()`);
    expect(Math.abs(block - TOPBAR_BLOCK), `the topbar takes ${block} px`).toBeLessThanOrEqual(1);
  });

  it("keeps the detail floor above the waveform's and the transcript's own minimums", async () => {
    const main = await page("/renderer/index.html", ".topbar");
    const floors = await evaluate<number>(main, `(() => {
      const minimum = (className, tag) => {
        const probe = document.createElement(tag);
        probe.className = className;
        document.body.append(probe);
        const value = parseFloat(getComputedStyle(probe).minHeight);
        probe.remove();
        return value;
      };
      return minimum("waveform-canvas", "div") + minimum("result-output result-output--tall", "textarea");
    })()`);
    expect(floors).toBeGreaterThan(0);
    expect(DETAIL_MIN_HEIGHT, `the waveform and transcript need ${floors} px`).toBeGreaterThanOrEqual(floors);
  });

  it("reserves for the records window's filters what they take", async () => {
    const main = await page("/renderer/index.html", ".topbar");
    await evaluate(main, "window.mumbler.openRecordsWindow()");
    const records = await page("/renderer/records.html", ".records-filters");
    const band = await evaluate<number>(records, `document.querySelector(".records-filters").getBoundingClientRect().height`);
    expect(Math.abs(band - RECORDS_FILTERS_HEIGHT), `the filters take ${band} px`).toBeLessThanOrEqual(1);
  });
});
