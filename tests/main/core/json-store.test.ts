import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NewerFormatError } from "@main/core/format-versions";
import { CorruptStateError, JsonStore, UnreadableStoreError } from "@main/core/json-store";
import { header } from "../../support/file-header";

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
    format: { kind: "doc", version: 1 },
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
    await writeFile(store.path, JSON.stringify({ ...header("doc"), value: "hi", extra: 1 }), "utf8");
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
    const newer = JSON.stringify({ ...header("doc", 2), value: "future" });
    await writeFile(store.path, newer, "utf8");
    const error = await store.load().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NewerFormatError);
    expect(error).not.toBeInstanceOf(CorruptStateError);
    expect(error).toMatchObject({ filePath: store.path, recorded: 2, supported: 1 });
    expect(await readFile(store.path, "utf8")).toBe(newer);
    expect((await readdir(dir)).sort()).toEqual(["doc.json"]);
  });

  it.each<[string, Record<string, unknown>]>([
    ["no header", {}],
    ["a header that is not an object", { format: "mumbler.doc" }],
    ["another owner", { format: { owner: "otherapp", kind: "doc", version: 1 } }],
    ["another kind", { format: { owner: "mumbler", kind: "config", version: 1 } }],
    ["a kind that is not text", { format: { owner: "mumbler", kind: 1, version: 1 } }],
    ...[undefined, 0, -1, 1.5, "1", null].map((version) => [`version ${String(version)}`, { format: { owner: "mumbler", kind: "doc", version } }] as [string, Record<string, unknown>]),
    ["the old marker only", { formatVersion: 1 }],
  ])("treats a file with %s as corruption, untouched", async (_name, identity) => {
    const store = makeStore();
    const text = JSON.stringify({ ...identity, value: "odd" });
    await writeFile(store.path, text, "utf8");
    await expect(store.load()).rejects.toBeInstanceOf(CorruptStateError);
    expect(await readFile(store.path, "utf8")).toBe(text);
  });

  it("writes no sidecar file: a successful load leaves only the canonical file", async () => {
    const store = makeStore();
    await writeFile(store.path, JSON.stringify({ ...header("doc"), value: "good" }), "utf8");
    await store.load();
    expect((await readdir(dir)).sort()).toEqual(["doc.json"]);
  });
});

describe("JsonStore.save / flush", () => {
  it("writes the value atomically, its header first", async () => {
    const store = makeStore();
    await store.save({ value: "written" });
    expect(Object.keys(await read(store.path) as object)).toEqual(["format", "writer", "value"]);
    expect(await read(store.path)).toEqual({ ...header("doc"), value: "written" });
  });

  it("reads a file whatever its writer says, and hands validate only the content", async () => {
    let seen: Record<string, unknown> = {};
    const store = new JsonStore<Doc>({
      path: join(dir, "doc.json"),
      format: { kind: "doc", version: 1 },
      validate: (raw) => { seen = raw; return { value: String(raw.value) }; },
      createDefault: () => ({ value: "default" }),
    });
    for (const writer of [undefined, null, "anything", { name: "otherapp", version: 99 }]) {
      await writeFile(store.path, JSON.stringify({ format: header("doc").format, writer, value: "read" }), "utf8");
      expect((await store.load()).value).toEqual({ value: "read" });
      expect(seen).toEqual({ value: "read" });
    }
  });

  it("serializes overlapping saves so the last one wins and none are lost", async () => {
    const store = makeStore();
    const writes = Array.from({ length: 20 }, (_, i) =>
      store.save({ value: `v${i}` }),
    );
    await Promise.all(writes);
    expect(await read(store.path)).toEqual({ ...header("doc"), value: "v19" });
  });

  it("flush resolves only after queued writes have landed", async () => {
    const store = makeStore();
    void store.save({ value: "a" });
    void store.save({ value: "b" });
    await store.flush();
    expect(await read(store.path)).toEqual({ ...header("doc"), value: "b" });
  });

  it("a failed write rejects but does not wedge the queue, and flush stays resolvable", async () => {
    // Put a file where the store needs a directory, so the first write fails
    // deterministically (mkdir of the parent throws ENOTDIR).
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "x", "utf8");
    const store = new JsonStore<Doc>({
      path: join(blocker, "doc.json"),
      format: { kind: "doc", version: 1 },
      validate: (raw) => ({ value: typeof raw.value === "string" ? raw.value : "fallback" }),
      createDefault: () => ({ value: "default" }),
    });

    await expect(store.save({ value: "fails" })).rejects.toThrow();
    // flush must not reject just because a prior save failed.
    await expect(store.flush()).resolves.toBeUndefined();

    // Unblock and confirm the queue still accepts and lands new writes.
    await rm(blocker);
    await store.save({ value: "ok" });
    expect(await read(store.path)).toEqual({ ...header("doc"), value: "ok" });
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

describe("a refused file is never changed", () => {
  it.each([
    ["newer", JSON.stringify({ ...header("doc", 2), value: "future" })],
    ["damaged", "{ half a document"],
    ["of another kind", JSON.stringify({ ...header("config"), value: "settings" })],
  ])("refuses every save after loading a %s file, leaving it byte-identical", async (_kind, text) => {
    const store = makeStore();
    await writeFile(store.path, text, "utf8");
    await expect(store.load()).rejects.toThrow();
    await expect(store.save({ value: "over it" })).rejects.toThrow("was refused when it was read");
    await expect(store.retryFailedWrite()).resolves.toBeUndefined();
    expect(await readFile(store.path, "utf8")).toBe(text);
    expect(await readdir(dir)).toEqual(["doc.json"]);
  });

  it("lets a disposable store's next save replace a damaged file, never a newer one", async () => {
    const disposable = (): JsonStore<Doc> => new JsonStore<Doc>({
      path: join(dir, "doc.json"),
      format: { kind: "doc", version: 1 },
      disposable: true,
      validate: (raw) => ({ value: String(raw.value) }),
      createDefault: () => ({ value: "default" }),
    });
    const damaged = disposable();
    await writeFile(damaged.path, "{ half a document", "utf8");
    await expect(damaged.load()).rejects.toBeInstanceOf(CorruptStateError);
    await damaged.save({ value: "replaced" });
    expect(await read(damaged.path)).toEqual({ ...header("doc"), value: "replaced" });

    const newer = disposable();
    const text = JSON.stringify({ ...header("doc", 2), value: "future" });
    await writeFile(newer.path, text, "utf8");
    await expect(newer.load()).rejects.toBeInstanceOf(NewerFormatError);
    await expect(newer.save({ value: "over it" })).rejects.toThrow();
    expect(await readFile(newer.path, "utf8")).toBe(text);
  });
});

describe("JsonStore failed writes", () => {
  function storeIn(folder: string): JsonStore<Doc> {
    return new JsonStore<Doc>({
      path: join(folder, "doc.json"),
      format: { kind: "doc", version: 1 },
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
    expect(await read(join(folder, "doc.json"))).toEqual({ ...header("doc"), value: "kept" });
  });

  it("retries nothing when the latest write landed", async () => {
    const store = makeStore();
    await store.save({ value: "landed" });
    await writeFile(join(dir, "doc.json"), "changed by hand");

    await store.retryFailedWrite();

    expect(await readFile(join(dir, "doc.json"), "utf8")).toBe("changed by hand");
  });
});
