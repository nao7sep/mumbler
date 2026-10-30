import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const observed = vi.hoisted(() => ({ spawned: undefined as ((child: ChildProcess) => void) | undefined }));
const cleanupFault = vi.hoisted(() => ({ refused: false }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, rm: (...args: Parameters<typeof actual.rm>) => {
    if (cleanupFault.refused && /[\\/]temp[\\/]/.test(String(args[0]))) return Promise.reject(new Error("removal refused"));
    return actual.rm(...args);
  } };
});

// Run the stand-in through real Node on every OS, preserving execFile's real
// promise and child. Only executable selection and child observation differ.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const viaNode = (file: string, args: readonly string[]): [string, string[]] =>
    file.endsWith(".cjs") ? [process.execPath, [file, ...args]] : [file, [...args]];
  const spawn = ((file: string, args: readonly string[], options: Parameters<typeof actual.spawn>[2]) => {
    const child = actual.spawn(...viaNode(file, args), options);
    observed.spawned?.(child);
    return child;
  }) as typeof actual.spawn;
  return { ...actual, spawn };
});

import { configureToolResolver, prepareAudioForTranscription } from "@main/core/audio-tools";
import { isCancelledError } from "@main/core/cancellation";
import type { TrimDecision } from "@shared/app-shell";

let directory: string;
let scratchDir: string;
let sourceFilePath: string;

beforeEach(async () => {
  cleanupFault.refused = false;
  directory = await mkdtemp(join(tmpdir(), "mumbler-preparation-owner-"));
  scratchDir = join(directory, "cards", "c1", "temp");
  sourceFilePath = join(directory, "recording.wav");
  const script = join(directory, "ffmpeg.cjs");
  await writeFile(sourceFilePath, "original recording");
  await mkdir(scratchDir, { recursive: true });
  await writeFile(join(scratchDir, "other.wav"), "another preparation's audio");
  await writeFile(script, [
    "const { existsSync, writeFileSync } = require('node:fs');",
    "const output = process.argv.at(-1);",
    "writeFileSync(output, 'partial derived audio');",
    // The test asks for the failure by creating this file beside the source.
    `const trigger = ${JSON.stringify(join(directory, "fail-now"))};`,
    "setInterval(() => {",
    "  if (!existsSync(trigger)) return;",
    "  writeFileSync(output, 'last bytes before failure');",
    "  process.stderr.write('encoder failure sentinel');",
    "  process.exit(7);",
    "}, 10);",
    "process.stdout.write('partial ready');",
  ].join("\n"));
  configureToolResolver(() => script);
});

afterEach(async () => {
  cleanupFault.refused = false;
  observed.spawned = undefined;
  await rm(directory, { recursive: true, force: true });
});

describe("audio preparation owns unsuccessful derived files", () => {
  it.each([
    ["stream-copy", "failure", false], ["reencode", "failure", false],
    ["stream-copy", "cancel", false], ["reencode", "cancel", false],
    ["stream-copy", "failure", true], ["reencode", "cancel", true],
  ] as const)("cleans repeated %s outputs after %s while preserving the primary result (cleanup refused: %s)", async (mode, result, refused) => {
    cleanupFault.refused = refused;
    for (let attempt = 0; attempt < 2; attempt++) {
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), providerCall: vi.fn() };
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
        sourceFilePath, scratchDir,
        trim: { frontMarkerSec: 1, backMarkerSec: 2 },
        trimDecision: { kind: mode, chosenStartBoundarySec: 1, chosenEndBoundarySec: 2 } as TrimDecision,
        durationSec: 3, audioProfile: null, signal: controller.signal, logger,
      }).then((prepared) => prepared, (error: unknown) => error).finally(() => { settled = true; });
      try {
        await ready;
        const outputPath = child!.spawnargs.at(-1)!;
        expect(await readFile(outputPath, "utf8")).toBe("partial derived audio");
        expect(settled, "the child still owns its output before it is released").toBe(false);
        if (result === "cancel") controller.abort();
        else await writeFile(join(directory, "fail-now"), "");
        const error = await pending;
        if (result === "cancel") expect(error).toSatisfy(isCancelledError);
        else {
          expect(error).toMatchObject({ code: 7 });
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toContain("encoder failure sentinel");
        }
        if (refused) {
          expect(await readdir(scratchDir)).toContain(outputPath.split(/[\\/]/).at(-1));
          expect(logger.warn).toHaveBeenCalledExactlyOnceWith("audio.cleanup-failed", expect.any(String), expect.objectContaining({ error: expect.objectContaining({ message: "removal refused" }) }));
        } else {
          expect(await readdir(scratchDir)).toEqual(["other.wav"]);
          expect(logger.warn).not.toHaveBeenCalled();
        }
        expect(await readFile(sourceFilePath, "utf8")).toBe("original recording");
        expect(await readFile(join(scratchDir, "other.wav"), "utf8")).toBe("another preparation's audio");
      } finally {
        controller.abort();
        await pending;
        await rm(join(directory, "fail-now"), { force: true });
      }
    }
  });
});
