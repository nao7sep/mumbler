import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MumblerCard } from "@shared/app-shell";
import { CorruptStateError } from "@main/core/json-store";
import { TranscriptStore } from "@main/core/transcript-store";

let dir: string;

beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), "mumbler-transcripts-")), "transcripts");
});

afterEach(async () => {
  await rm(join(dir, ".."), { recursive: true, force: true });
});

function card(id: string, transcription: string | null, structured: string | null = null): MumblerCard {
  return {
    id,
    transcription: { text: transcription },
    metadata: { structured, title: null, slug: null },
  } as MumblerCard;
}

async function files(): Promise<string[]> {
  return (await readdir(dir).catch(() => [])).sort();
}

describe("TranscriptStore", () => {
  it("writes a card's text once, and again only when it changes", async () => {
    const store = new TranscriptStore(dir);
    const take = card("take", "the words", "## outline");

    expect(await store.writeChanged([take])).toBe(1);
    expect(await store.writeChanged([take]), "an unchanged save writes nothing").toBe(0);
    take.metadata.structured = "## better outline";
    expect(await store.writeChanged([take])).toBe(1);

    const [name] = await files();
    expect(JSON.parse(await readFile(join(dir, name), "utf8"))).toEqual({
      schemaVersion: 1,
      cardId: "take",
      transcription: "the words",
      structured: "## better outline",
    });
  });

  it("writes nothing for a card without text", async () => {
    const store = new TranscriptStore(dir);

    expect(await store.writeChanged([card("fresh", null)])).toBe(0);
    expect(await files()).toEqual([]);
  });

  it("deletes the file of a card that is gone or has lost its text", async () => {
    const store = new TranscriptStore(dir);
    const kept = card("kept", "kept words");
    const cleared = card("cleared", "old words");
    const removed = card("removed", "removed words");
    await store.writeChanged([kept, cleared, removed]);

    cleared.transcription.text = null;
    await store.removeAbsent([kept, cleared]);

    const reopened = await new TranscriptStore(dir).open(["kept", "cleared", "removed"]);
    expect([...reopened.keys()]).toEqual(["kept"]);
  });

  it("gives ids that differ only in case their own files", async () => {
    const store = new TranscriptStore(dir);

    await store.writeChanged([card("AbC", "upper"), card("abc", "lower")]);

    expect(await files()).toHaveLength(2);
    const reopened = await new TranscriptStore(dir).open(["AbC", "abc"]);
    expect(reopened.get("AbC")?.transcription).toBe("upper");
    expect(reopened.get("abc")?.transcription).toBe("lower");
  });

  it("reads what it wrote, and sweeps files no card refers to", async () => {
    await new TranscriptStore(dir).writeChanged([card("live", "live words", "live outline"), card("orphan", "stale")]);

    const store = new TranscriptStore(dir);
    const transcripts = await store.open(["live"]);

    expect(transcripts.get("live")).toEqual({ transcription: "live words", structured: "live outline" });
    expect(await files()).toHaveLength(1);
    expect(await store.writeChanged([card("live", "live words", "live outline")]), "what it read counts as written").toBe(0);
  });

  it("opens an empty store when the folder does not exist yet", async () => {
    expect((await new TranscriptStore(dir).open(["any"])).size).toBe(0);
  });

  it("refuses a file it cannot read and leaves it in place", async () => {
    await new TranscriptStore(dir).writeChanged([card("take", "words")]);
    const [name] = await files();
    await writeFile(join(dir, name), "{ not json");

    await expect(new TranscriptStore(dir).open(["take"])).rejects.toBeInstanceOf(CorruptStateError);
    expect(await readFile(join(dir, name), "utf8")).toBe("{ not json");
  });

  it("ignores files it did not name", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "notes.txt"), "mine");

    await new TranscriptStore(dir).open([]);

    expect(await files()).toEqual(["notes.txt"]);
  });
});
