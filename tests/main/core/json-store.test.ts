import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CorruptStateError, JsonStore } from "@main/core/json-store";

interface Doc {
  schemaVersion: number;
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
    schemaVersion: 1,
    validate: (raw) => ({
      schemaVersion: 1,
      value: typeof raw.value === "string" ? raw.value : "fallback",
    }),
    createDefault: () => ({ schemaVersion: 1, value: "default" }),
  });
}

async function read(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

describe("JsonStore.load", () => {
  it("returns in-memory defaults without writing when the file is missing", async () => {
    const store = makeStore();
    const result = await store.load();
    expect(result).toEqual({ value: { schemaVersion: 1, value: "default" }, origin: "created" });
    // Crucially, load must not have created the file.
    await expect(readFile(store.path, "utf8")).rejects.toThrow();
  });

  it("validates a present file and reports origin 'loaded'", async () => {
    const store = makeStore();
    await writeFile(store.path, JSON.stringify({ schemaVersion: 1, value: "hi", extra: 1 }), "utf8");
    const result = await store.load();
    expect(result.origin).toBe("loaded");
    expect(result.value).toEqual({ schemaVersion: 1, value: "hi" });
  });

  it("throws CorruptStateError on malformed JSON and leaves the file untouched", async () => {
    const store = makeStore();
    await writeFile(store.path, "{ not valid json", "utf8");
    await expect(store.load()).rejects.toBeInstanceOf(CorruptStateError);
    // The bad file is preserved exactly as-is (no overwrite, no delete).
    expect(await readFile(store.path, "utf8")).toBe("{ not valid json");
  });

  it("refuses a schema version newer than this build and leaves the file untouched", async () => {
    const store = makeStore();
    const newer = JSON.stringify({ schemaVersion: 99, value: "future" });
    await writeFile(store.path, newer, "utf8");
    await expect(store.load()).rejects.toBeInstanceOf(CorruptStateError);
    expect(await readFile(store.path, "utf8")).toBe(newer);
  });

  it("writes no sidecar file: a successful load leaves only the canonical file", async () => {
    const store = makeStore();
    await writeFile(store.path, JSON.stringify({ schemaVersion: 1, value: "good" }), "utf8");
    await store.load();
    expect((await readdir(dir)).sort()).toEqual(["doc.json"]);
  });
});

describe("JsonStore.save / flush", () => {
  it("writes the value atomically", async () => {
    const store = makeStore();
    await store.save({ schemaVersion: 1, value: "written" });
    expect(await read(store.path)).toEqual({ schemaVersion: 1, value: "written" });
  });

  it("serializes overlapping saves so the last one wins and none are lost", async () => {
    const store = makeStore();
    const writes = Array.from({ length: 20 }, (_, i) =>
      store.save({ schemaVersion: 1, value: `v${i}` }),
    );
    await Promise.all(writes);
    expect(await read(store.path)).toEqual({ schemaVersion: 1, value: "v19" });
  });

  it("flush resolves only after queued writes have landed", async () => {
    const store = makeStore();
    void store.save({ schemaVersion: 1, value: "a" });
    void store.save({ schemaVersion: 1, value: "b" });
    await store.flush();
    expect(await read(store.path)).toEqual({ schemaVersion: 1, value: "b" });
  });

  it("a failed write rejects but does not wedge the queue, and flush stays resolvable", async () => {
    // Put a file where the store needs a directory, so the first write fails
    // deterministically (mkdir of the parent throws ENOTDIR).
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "x", "utf8");
    const store = new JsonStore<Doc>({
      path: join(blocker, "doc.json"),
      schemaVersion: 1,
      validate: (raw) => ({ schemaVersion: 1, value: typeof raw.value === "string" ? raw.value : "fallback" }),
      createDefault: () => ({ schemaVersion: 1, value: "default" }),
    });

    await expect(store.save({ schemaVersion: 1, value: "fails" })).rejects.toThrow();
    // flush must not reject just because a prior save failed.
    await expect(store.flush()).resolves.toBeUndefined();

    // Unblock and confirm the queue still accepts and lands new writes.
    await rm(blocker);
    await store.save({ schemaVersion: 1, value: "ok" });
    expect(await read(store.path)).toEqual({ schemaVersion: 1, value: "ok" });
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

  it("accepts (does not refuse) a file from an older schema version", async () => {
    const store = makeStore();
    await writeFile(store.path, JSON.stringify({ schemaVersion: 0, value: "old" }), "utf8");
    const result = await store.load();
    expect(result.origin).toBe("loaded");
    expect(result.value).toEqual({ schemaVersion: 1, value: "old" });
  });
});

describe("JsonStore.preserveExistingFiles", () => {
  it("returns no paths and throws nothing when the file does not exist", async () => {
    const store = makeStore();
    await expect(store.preserveExistingFiles()).resolves.toEqual([]);
  });

  it("moves the canonical file aside, preserving its contents under a quarantined .invalid name", async () => {
    const store = makeStore();
    await writeFile(store.path, JSON.stringify({ schemaVersion: 1, value: "canonical" }), "utf8");

    const preserved = await store.preserveExistingFiles();

    expect(preserved).toHaveLength(1);
    await expect(readFile(store.path, "utf8")).rejects.toThrow();
    expect(await read(preserved[0]!)).toEqual({ schemaVersion: 1, value: "canonical" });
    expect(preserved[0]!).toMatch(/doc-\d{8}-\d{6}-\d{3}-utc\.invalid$/);
  });

  it("the Reset sequence does not erase the user's last readable copy", async () => {
    // Reset sets the original aside and writes defaults. The original data must
    // stay recoverable from the preserved copy, and nothing else should leak.
    const store = makeStore();
    await writeFile(store.path, JSON.stringify({ schemaVersion: 1, value: "real" }), "utf8");
    await store.load();

    const preserved = await store.preserveExistingFiles();
    await store.save({ schemaVersion: 1, value: "default" });

    // The live file is now defaults...
    expect(await read(store.path)).toEqual({ schemaVersion: 1, value: "default" });
    // ...but the original "real" data is still recoverable from the preserved copy.
    expect(await read(preserved[0]!)).toEqual({ schemaVersion: 1, value: "real" });

    // And nothing leaked: exactly the canonical and the preserved copy remain.
    const remaining = await readdir(dir);
    expect(remaining.sort()).toEqual(
      ["doc.json", ...preserved.map((p) => p.slice(dir.length + 1))].sort(),
    );
  });
});
