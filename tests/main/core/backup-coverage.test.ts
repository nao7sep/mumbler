// Which saves reach the backup history (data-backup-conventions; developer
// decision): settings are what the user authors and are recorded; the queue
// with its review drafts is transient work and transcripts are derived, so
// neither is. The hook itself is mocked; backupStore.test.ts owns the store.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { MumblerCard } from "@shared/app-shell";

const { backupRecord } = vi.hoisted(() => ({ backupRecord: vi.fn() }));
vi.mock("@main/core/backupStore", () => ({ record: backupRecord }));

const { createDefaultSettings, createEmptyQueue, createQueueStore, createSettingsStore } = await import("@main/core/settings-schema");
const { TranscriptStore } = await import("@main/core/transcript-store");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mumbler-backup-coverage-"));
  backupRecord.mockClear();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it("records a settings save", async () => {
  const path = join(dir, "config.json");
  await createSettingsStore(path, dir).save({ ...createDefaultSettings(), concurrencyLimit: 5 });
  expect(backupRecord).toHaveBeenCalledOnce();
  expect(backupRecord).toHaveBeenCalledWith(path, expect.any(Buffer));
});

it("does not record the queue or a transcript", async () => {
  await createQueueStore(join(dir, "queue.json")).save(createEmptyQueue());
  await new TranscriptStore(join(dir, "transcripts")).writeChanged([
    { id: "take", transcription: { text: "words" }, metadata: { structured: null, title: null, slug: null } } as MumblerCard,
  ]);
  expect(backupRecord).not.toHaveBeenCalled();
});
