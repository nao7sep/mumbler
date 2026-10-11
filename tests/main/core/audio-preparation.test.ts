import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const observed = vi.hoisted(() => ({ spawned: undefined as ((child: ChildProcess) => void) | undefined }));

// Run the stand-in through real Node on every OS, preserving execFile's real
// promise and child. Only executable selection and child observation differ.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const viaNode = (file: string, args: readonly string[]): [string, string[]] =>
    file.endsWith(".cjs") ? [process.execPath, [file, ...args]] : [file, [...args]];
  const execFile = ((file: string, args: readonly string[], ...rest: unknown[]) =>
    (actual.execFile as (...all: unknown[]) => unknown)(...viaNode(file, args), ...rest)) as unknown as typeof actual.execFile;
  const custom = (actual.execFile as unknown as Record<symbol, (...all: unknown[]) => unknown>)[promisify.custom];
  Object.defineProperty(execFile, promisify.custom, {
    value: (file: string, args: readonly string[], ...rest: unknown[]) => {
      const pending = custom(...viaNode(file, args), ...rest) as Promise<unknown> & { child: ChildProcess };
      observed.spawned?.(pending.child);
      return pending;
    },
  });
  return { ...actual, execFile };
});

import { configureToolResolver, prepareAudioForTranscription } from "@main/core/audio-tools";
import { isCancelledError } from "@main/core/cancellation";
import type { TrimDecision } from "@shared/app-shell";

let directory: string;
let workingDir: string;
let sourceFilePath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "mumbler-preparation-owner-"));
  workingDir = join(directory, "working");
  sourceFilePath = join(directory, "recording.wav");
  const script = join(directory, "ffmpeg.cjs");
  await writeFile(sourceFilePath, "original recording");
  await mkdir(join(workingDir, "derived"), { recursive: true });
  await writeFile(join(workingDir, "derived", "other.wav"), "another preparation's audio");
  await writeFile(script, [
    "const { writeFileSync } = require('node:fs');",
    "const output = process.argv.at(-1);",
    "writeFileSync(output, 'partial derived audio');",
    "process.stdin.on('data', () => {",
    "  writeFileSync(output, 'last bytes before failure');",
    "  process.stderr.write('encoder failure sentinel');",
    "  process.exit(7);",
    "});",
    "process.stdin.resume();",
    "process.stdout.write('partial ready');",
  ].join("\n"));
  configureToolResolver(() => script);
});

afterEach(async () => {
  observed.spawned = undefined;
  await rm(directory, { recursive: true, force: true });
});

describe("audio preparation owns unsuccessful derived files", () => {
  it.each([
    ["stream-copy", "failure"], ["reencode", "failure"],
    ["stream-copy", "cancel"], ["reencode", "cancel"],
  ] as const)("cleans repeated %s outputs after %s while preserving the source and primary result", async (mode, result) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      let child: ChildProcess | undefined;
      let settled = false;
      const ready = new Promise<void>((resolve) => {
        observed.spawned = (spawned) => {
          child = spawned;
          spawned.stdout!.once("data", () => resolve());
        };
      });
      const pending = prepareAudioForTranscription({
        sourceFilePath, workingDir,
        trim: { frontMarkerSec: 1, backMarkerSec: 2 },
        trimDecision: { kind: mode, chosenStartBoundarySec: 1, chosenEndBoundarySec: 2 } as TrimDecision,
        durationSec: 3, audioProfile: null, signal: controller.signal,
      }).then((prepared) => prepared, (error: unknown) => error).finally(() => { settled = true; });
      try {
        await ready;
        const outputPath = child!.spawnargs.at(-1)!;
        expect(await readFile(outputPath, "utf8")).toBe("partial derived audio");
        expect(settled, "the child still owns its output before it is released").toBe(false);
        if (result === "cancel") controller.abort();
        else child!.stdin!.end("finish\n");
        const error = await pending;
        if (result === "cancel") expect(error).toSatisfy(isCancelledError);
        else {
          expect(error).toMatchObject({ code: 7 });
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toContain("encoder failure sentinel");
        }
        expect(await readdir(join(workingDir, "derived"))).toEqual(["other.wav"]);
        expect(await readFile(sourceFilePath, "utf8")).toBe("original recording");
        expect(await readFile(join(workingDir, "derived", "other.wav"), "utf8")).toBe("another preparation's audio");
      } finally {
        controller.abort();
        await pending;
      }
    }
  });
});
