import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NewerFormatError } from "@main/core/format-versions";
import { CorruptStateError, JsonStore, UnreadableStoreError } from "@main/core/json-store";

interface Doc {
  value: string;
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mumbler-store-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeStore(): JsonStore<Doc> {
  return new JsonStore<Doc>({
    path: join(dir, "doc.json"),
    formatVersion: 1,
    validate: (raw) => ({
      value: typeof raw.value === "string" ? raw.value : "fallback",
    }),
    createDefault: () => ({ value: "default" }),
  });
}

async function read(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

describe("JsonStore.load", () => {
  it("returns in-memory defaults without writing when the file is missing", async () => {
    const store = makeStore();
    const result = await store.load();
    expect(result).toEqual({ value: { value: "default" }, origin: "created" });
    // Crucially, load must not have created the file.
    await expect(readFile(store.path, "utf8")).rejects.toThrow();
  });

  it("validates a present file and reports origin 'loaded'", async () => {
    const store = makeStore();
    await writeFile(store.path, JSON.stringify({ formatVersion: 1, value: "hi", extra: 1 }), "utf8");
    const result = await store.load();
    expect(result.origin).toBe("loaded");
    expect(result.value).toEqual({ value: "hi" });
  });

  it("throws CorruptStateError on malformed JSON and leaves the file untouched", async () => {
    const store = makeStore();
    await writeFile(store.path, "{ not valid json", "utf8");
    await expect(store.load()).rejects.toBeInstanceOf(CorruptStateError);
    // The bad file is preserved exactly as-is (no overwrite, no delete).
    expect(await readFile(store.path, "utf8")).toBe("{ not valid json");
  });

  it("treats a file holding the JSON literal null as corruption, not as a missing file, untouched", async () => {
    const store = makeStore();
    await writeFile(store.path, "null", "utf8");
    await expect(store.load()).rejects.toBeInstanceOf(CorruptStateError);
    expect(await readFile(store.path, "utf8")).toBe("null");
  });

  it("reports a file that cannot be read as unreadable, not damaged, keeping the read's error", async () => {
    const store = makeStore();
    await mkdir(store.path);
    const error = await store.load().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnreadableStoreError);
    expect(error).not.toBeInstanceOf(CorruptStateError);
    expect(error).toMatchObject({ filePath: store.path, cause: { code: "EISDIR" } });
  });

  it("refuses a format version newer than this build as intact, not corrupt, and leaves the file untouched", async () => {
    const store = makeStore();
    const newer = JSON.stringify({ formatVersion: 2, value: "future" });
    await writeFile(store.path, newer, "utf8");
    const error = await store.load().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NewerFormatError);
    expect(error).not.toBeInstanceOf(CorruptStateError);
    expect(error).toMatchObject({ filePath: store.path, recorded: 2, supported: 1 });
    expect(await readFile(store.path, "utf8")).toBe(newer);
    expect((await readdir(dir)).sort()).toEqual(["doc.json"]);
  });

  it("treats a missing format version, or one that is not a positive integer, as corruption, untouched", async () => {
    const store = makeStore();
    for (const marker of [undefined, 0, -1, 1.5, "1", null]) {
      const text = JSON.stringify({ formatVersion: marker, value: "odd" });
      await writeFile(store.path, text, "utf8");
      await expect(store.load()).rejects.toBeInstanceOf(CorruptStateError);
      expect(await readFile(store.path, "utf8")).toBe(text);
    }
  });

  it("writes no sidecar file: a successful load leaves only the canonical file", async () => {
    const store = makeStore();
    await writeFile(store.path, JSON.stringify({ formatVersion: 1, value: "good" }), "utf8");
    await store.load();
    expect((await readdir(dir)).sort()).toEqual(["doc.json"]);
  });
});

describe("JsonStore.save / flush", () => {
  it("writes the value atomically, its format version first", async () => {
    const store = makeStore();
    await store.save({ value: "written" });
    expect(await readFile(store.path, "utf8")).toBe('{\n  "formatVersion": 1,\n  "value": "written"\n}\n');
  });

  it("serializes overlapping saves so the last one wins and none are lost", async () => {
    const store = makeStore();
    const writes = Array.from({ length: 20 }, (_, i) =>
      store.save({ value: `v${i}` }),
    );
    await Promise.all(writes);
    expect(await read(store.path)).toEqual({ formatVersion: 1, value: "v19" });
  });

  it("flush resolves only after queued writes have landed", async () => {
    const store = makeStore();
    void store.save({ value: "a" });
    void store.save({ value: "b" });
    await store.flush();
    expect(await read(store.path)).toEqual({ formatVersion: 1, value: "b" });
  });

  it("a failed write rejects but does not wedge the queue, and flush stays resolvable", async () => {
    // Put a file where the store needs a directory, so the first write fails
    // deterministically (mkdir of the parent throws ENOTDIR).
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "x", "utf8");
    const store = new JsonStore<Doc>({
      path: join(blocker, "doc.json"),
      formatVersion: 1,
      validate: (raw) => ({ value: typeof raw.value === "string" ? raw.value : "fallback" }),
      createDefault: () => ({ value: "default" }),
    });

    await expect(store.save({ value: "fails" })).rejects.toThrow();
    // flush must not reject just because a prior save failed.
    await expect(store.flush()).resolves.toBeUndefined();

    // Unblock and confirm the queue still accepts and lands new writes.
    await rm(blocker);
    await store.save({ value: "ok" });
    expect(await read(store.path)).toEqual({ formatVersion: 1, value: "ok" });
  });
});

describe("JsonStore.load — structural edge cases", () => {
  it("treats a valid-JSON but non-object file as corruption, untouched", async () => {
    const store = makeStore();
    for (const garbage of ["[]", "42", '"a string"']) {
      await writeFile(store.path, garbage, "utf8");
      await expect(store.load()).rejects.toBeInstanceOf(CorruptStateError);
      expect(await readFile(store.path, "utf8")).toBe(garbage);
    }
  });
});

describe("JsonStore.preserveExistingFiles", () => {
  it("refuses to move a newer store aside even after it was loaded", async () => {
    const store = makeStore();
    await store.save({ value: "old" });
    await store.load();
    const text = JSON.stringify({ formatVersion: 2, value: "future" });
    await writeFile(store.path, text);
    await expect(store.preserveExistingFiles()).rejects.toBeInstanceOf(NewerFormatError);
    expect(await readFile(store.path, "utf8")).toBe(text);
  });

  it("returns no paths and throws nothing when the file does not exist", async () => {
    const store = makeStore();
    await expect(store.preserveExistingFiles()).resolves.toEqual([]);
  });

  it("moves the canonical file aside, preserving its contents under a quarantined .invalid name", async () => {
    const store = makeStore();
    await writeFile(store.path, JSON.stringify({ formatVersion: 1, value: "canonical" }), "utf8");

    const preserved = await store.preserveExistingFiles();

    expect(preserved).toHaveLength(1);
    await expect(readFile(store.path, "utf8")).rejects.toThrow();
    expect(await read(preserved[0]!)).toEqual({ formatVersion: 1, value: "canonical" });
    expect(preserved[0]!).toMatch(/doc-\d{8}-\d{6}-\d{3}-utc\.invalid$/);
  });

  it("the Reset sequence does not erase the user's last readable copy", async () => {
    // Reset sets the original aside and writes defaults. The original data must
    // stay recoverable from the preserved copy, and nothing else should leak.
    const store = makeStore();
    await writeFile(store.path, JSON.stringify({ formatVersion: 1, value: "real" }), "utf8");
    await store.load();

    const preserved = await store.preserveExistingFiles();
    await store.save({ value: "default" });

    // The live file is now defaults...
    expect(await read(store.path)).toEqual({ formatVersion: 1, value: "default" });
    // ...but the original "real" data is still recoverable from the preserved copy.
    expect(await read(preserved[0]!)).toEqual({ formatVersion: 1, value: "real" });

    // And nothing leaked: exactly the canonical and the preserved copy remain.
    const remaining = await readdir(dir);
    expect(remaining.sort()).toEqual(
      ["doc.json", ...preserved.map((p) => p.slice(dir.length + 1))].sort(),
    );
  });
});

describe("JsonStore failed writes", () => {
  function storeIn(folder: string): JsonStore<Doc> {
    return new JsonStore<Doc>({
      path: join(folder, "doc.json"),
      formatVersion: 1,
      validate: (raw) => ({ value: String(raw.value) }),
      createDefault: () => ({ value: "default" }),
      record: false,
    });
  }

  it("keeps the value a failed write could not write, retries it, and forgets it once a write lands", async () => {
    // A file where the store's folder should be, so no write can land.
    const folder = join(dir, "blocked");
    await writeFile(folder, "not a folder");
    const store = storeIn(folder);

    await expect(store.save({ value: "kept" })).rejects.toThrow();
    const failure = store.failedWrite;
    expect(failure?.value).toEqual({ value: "kept" });

    await expect(store.retryFailedWrite()).rejects.toThrow();
    expect(store.failedWrite, "each failure is a new one").not.toBe(failure);

    await rm(folder);
    await store.retryFailedWrite();
    expect(store.failedWrite).toBeNull();
    expect(await read(join(folder, "doc.json"))).toEqual({ formatVersion: 1, value: "kept" });
  });

  it("retries nothing when the latest write landed", async () => {
    const store = makeStore();
    await store.save({ value: "landed" });
    await writeFile(join(dir, "doc.json"), "changed by hand");

    await store.retryFailedWrite();

    expect(await readFile(join(dir, "doc.json"), "utf8")).toBe("changed by hand");
  });
});
