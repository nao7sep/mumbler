import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { copyIntoWorking, copyOriginalToBackup } from "@main/core/working-files";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mumbler-working-files-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("working audio copies", () => {
  it("copies imported audio under a case-insensitively unique working path", async () => {
    const source = join(dir, "source.wav");
    const working = join(dir, "working");
    await writeFile(source, "audio", "utf8");
    await mkdir(working, { recursive: true });
    await writeFile(join(working, "Clip.wav"), "existing", "utf8");

    const copied = await copyIntoWorking(source, working, "clip.wav");

    expect(basename(copied).toLowerCase()).not.toBe("clip.wav");
    expect(await readFile(copied, "utf8")).toBe("audio");
  });

  it("copies an original into the chosen backup directory", async () => {
    const source = join(dir, "source.m4a");
    const backup = join(dir, "backup");
    await writeFile(source, "audio", "utf8");

    const copied = await copyOriginalToBackup(source, backup);

    expect(copied).toBe(join(backup, "source.m4a"));
    expect(await readFile(copied, "utf8")).toBe("audio");
  });
});
