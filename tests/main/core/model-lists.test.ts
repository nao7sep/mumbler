import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppLogger } from "@main/core/logger";
const { list } = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = {
      list: async ({ config }: { config: { abortSignal: AbortSignal } }) =>
        ((await list(config.abortSignal)) as string[]).map((id) => ({ name: `models/${id}`, supportedActions: ["generateContent"] })),
    };
  },
}));
import { ModelLists } from "@main/core/model-lists";

let root: string;
let path: string;
const warn = vi.fn();
const logger = { warn } as unknown as AppLogger;
const endpoint = "https://provider.example";
const key = vi.fn(async () => "fixture-key");
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "mumbler-models-")); path = join(root, "model-lists.json"); list.mockReset(); warn.mockReset(); key.mockClear(); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("model-list facts", () => {
  it("does nothing before Settings requests a list and writes filtered facts once per day", async () => {
    const owner = new ModelLists(path, logger);
    expect(list).not.toHaveBeenCalled();
    list.mockResolvedValue(["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-future", "embedding", "gemini-3.5-flash-lite"]);
    expect(await owner.get(endpoint, false, key)).toEqual(["gemini-3.8-flash", "gemini-3.5-flash-lite"]);
    const raw = JSON.parse(await readFile(path, "utf8"));
    expect(raw).toEqual({ gemini: { fetchedAtUtc: expect.any(String), ids: ["gemini-3.8-flash", "gemini-3.5-flash-lite"] } });
    expect(await owner.get(endpoint, false, key)).toEqual(raw.gemini.ids);
    expect(list).toHaveBeenCalledOnce();
    await expect(readFile(join(process.env.MUMBLER_DATA_DIR!, "backups.sqlite3"))).rejects.toMatchObject({ code: "ENOENT" });
    await owner.get(endpoint, true, key);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("refreshes stale facts and shares a concurrent open/refresh request", async () => {
    await writeFile(path, JSON.stringify({ gemini: { fetchedAtUtc: "2020-01-01T00:00:00Z", ids: ["gemini-old"] } }));
    let resolve!: (ids: string[]) => void;
    list.mockReturnValue(new Promise<string[]>((done) => { resolve = done; }));
    const owner = new ModelLists(path, logger);
    const first = owner.get(endpoint, false, key);
    const second = owner.get(endpoint, true, key);
    await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
    resolve(["gemini-3.8-flash"]);
    expect(await first).toEqual(["gemini-3.8-flash"]);
    expect(await second).toEqual(["gemini-3.8-flash"]);
  });

  it("keeps prior facts when fetching fails, warns once, and never requires a key", async () => {
    await writeFile(path, JSON.stringify({ gemini: { fetchedAtUtc: "2020-01-01T00:00:00Z", ids: ["gemini-old"] } }));
    const owner = new ModelLists(path, logger);
    list.mockRejectedValue(new Error("offline"));
    expect(await owner.get(endpoint, true, key)).toEqual(["gemini-old"]);
    await owner.get(endpoint, true, key);
    expect(warn).toHaveBeenCalledOnce();
    expect(await owner.get(endpoint, true, async () => null)).toEqual(["gemini-old"]);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("does not repeat a failed automatic fetch when Settings opens again that day", async () => {
    list.mockRejectedValue(new Error("offline"));
    const owner = new ModelLists(path, logger);
    expect(await owner.get(endpoint, false, key)).toEqual([]);
    expect(await owner.get(endpoint, false, key)).toEqual([]);
    expect(list).toHaveBeenCalledOnce();
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cancels an in-flight refresh at shutdown without writing a new cache", async () => {
    list.mockImplementation((signal: AbortSignal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })));
    const owner = new ModelLists(path, logger);
    const running = owner.get(endpoint, true, key);
    await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
    await owner.close();
    expect(await running).toEqual([]);
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await owner.get(endpoint, true, key)).toEqual([]);
  });
});
