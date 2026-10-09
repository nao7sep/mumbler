import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MumblerCard } from "@shared/app-shell";
import { NewerFormatError } from "@main/core/format-versions";
import { CorruptStateError, UnreadableStoreError } from "@main/core/json-store";
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
  it("refuses a directory reset containing unreferenced newer text", async () => {
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${Buffer.from("lost").toString("hex")}.json`);
    const text = JSON.stringify({ formatVersion: 2, cardId: "lost", transcription: "future words" });
    await writeFile(path, text);
    const store = new TranscriptStore(dir);
    await store.open([]);
    await expect(store.preserveExistingFiles()).rejects.toBeInstanceOf(NewerFormatError);
    expect(await readFile(path, "utf8")).toBe(text);
  });

  it("sets malformed transcript bytes aside on explicit reset without deleting them", async () => {
    await mkdir(dir, { recursive: true });
    const name = `${Buffer.from("lost").toString("hex")}.json`;
    await writeFile(join(dir, name), "{ malformed");
    const preserved = await new TranscriptStore(dir).preserveExistingFiles();
    expect(preserved).not.toBeNull();
    expect(await readFile(join(preserved!, name), "utf8")).toBe("{ malformed");
  });

  it("writes a card's text once, and again only when it changes", async () => {
    const store = new TranscriptStore(dir);
    const take = card("take", "the words", "## outline");

    expect(await store.writeChanged([take])).toBe(1);
    expect(await store.writeChanged([take]), "an unchanged save writes nothing").toBe(0);
    take.metadata.structured = "## better outline";
    expect(await store.writeChanged([take])).toBe(1);

    const [name] = await files();
    expect(JSON.parse(await readFile(join(dir, name), "utf8"))).toEqual({
      formatVersion: 1,
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

  it("reads what it wrote, and keeps files no card refers to", async () => {
    await new TranscriptStore(dir).writeChanged([card("live", "live words", "live outline"), card("lost", "kept words")]);
    const before = await files();

    const store = new TranscriptStore(dir);
    const transcripts = await store.open(["live"]);

    expect(transcripts.get("live")).toEqual({ transcription: "live words", structured: "live outline" });
    expect([...transcripts.keys()]).toEqual(["live"]);
    expect(await store.writeChanged([card("live", "live words", "live outline")]), "what it read counts as written").toBe(0);
    await store.removeAbsent([card("live", "live words", "live outline")]);
    expect(await files(), "a file it did not open is not its to delete").toEqual(before);
  });

  it("does not halt on an unreadable file no card refers to", async () => {
    await mkdir(dir, { recursive: true });
    const name = `${Buffer.from("lost").toString("hex")}.json`;
    await writeFile(join(dir, name), "{ not json");

    expect((await new TranscriptStore(dir).open([])).size).toBe(0);
    expect(await readFile(join(dir, name), "utf8")).toBe("{ not json");
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

  it("refuses a file in a newer format as intact, not corrupt, and leaves it in place", async () => {
    await mkdir(dir, { recursive: true });
    const name = `${Buffer.from("take").toString("hex")}.json`;
    const newer = JSON.stringify({ formatVersion: 2, cardId: "take", transcription: "words", structured: null });
    await writeFile(join(dir, name), newer);

    const error = await new TranscriptStore(dir).open(["take"]).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NewerFormatError);
    expect(error).toMatchObject({ filePath: join(dir, name) });
    expect(await readFile(join(dir, name), "utf8")).toBe(newer);
  });

  it("refuses a file without its format version as unreadable and leaves it in place", async () => {
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${Buffer.from("take").toString("hex")}.json`);
    const unmarked = JSON.stringify({ cardId: "take", transcription: "words", structured: null });
    await writeFile(path, unmarked);

    await expect(new TranscriptStore(dir).open(["take"])).rejects.toBeInstanceOf(CorruptStateError);
    expect(await readFile(path, "utf8")).toBe(unmarked);
  });

  it("refuses a file holding the JSON literal null as unreadable and leaves it in place", async () => {
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${Buffer.from("take").toString("hex")}.json`);
    await writeFile(path, "null");

    await expect(new TranscriptStore(dir).open(["take"])).rejects.toBeInstanceOf(CorruptStateError);
    expect(await readFile(path, "utf8")).toBe("null");
  });

  it("refuses a file whose text is not text as unreadable and leaves it in place", async () => {
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${Buffer.from("take").toString("hex")}.json`);
    const wrong = JSON.stringify({ formatVersion: 1, cardId: "take", transcription: ["words"], structured: null });
    await writeFile(path, wrong);

    await expect(new TranscriptStore(dir).open(["take"])).rejects.toBeInstanceOf(CorruptStateError);
    expect(await readFile(path, "utf8")).toBe(wrong);
  });

  it("ignores files it did not name", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "notes.txt"), "mine");

    await new TranscriptStore(dir).open([]);

    expect(await files()).toEqual(["notes.txt"]);
  });

  it("refuses at load text belonging to another card, leaving the file unchanged", async () => {
    const store = new TranscriptStore(dir);
    const take = card("take", "old words");
    await store.writeChanged([take]);
    const [name] = await files();
    const path = join(dir, name);
    const foreign = JSON.stringify({ formatVersion: 1, cardId: "other", transcription: "other words" });
    await writeFile(path, foreign);
    await expect(new TranscriptStore(dir).open(["take"])).rejects.toBeInstanceOf(CorruptStateError);
    expect(await readFile(path, "utf8")).toBe(foreign);
  });

  it("reports malformed text as damaged and a file it cannot read as unreadable, both left in place", async () => {
    await mkdir(dir, { recursive: true });
    const name = `${Buffer.from("take").toString("hex")}.json`;
    await writeFile(join(dir, name), "{ not json");
    const damaged = await new TranscriptStore(dir).open(["take"]).catch((error: unknown) => error);
    expect(damaged).toBeInstanceOf(CorruptStateError);
    expect(await readFile(join(dir, name), "utf8")).toBe("{ not json");

    await rm(join(dir, name));
    await mkdir(join(dir, name));
    const unreadable = await new TranscriptStore(dir).open(["take"]).catch((error: unknown) => error);
    expect(unreadable).toBeInstanceOf(UnreadableStoreError);
    expect(unreadable).toMatchObject({ filePath: join(dir, name) });
    expect(await files()).toEqual([name]);
  });

  it("reports a transcripts folder it cannot list as unreadable", async () => {
    await writeFile(dir, "not a folder");
    const error = await new TranscriptStore(dir).open(["take"]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnreadableStoreError);
    expect(error).toMatchObject({ filePath: dir });
    expect(await readFile(dir, "utf8")).toBe("not a folder");
  });
});
