// Which saves reach the backup history (data-backup-conventions; developer
// decision): settings are what the user authors and are recorded; the queue
// with its review drafts and each card's text is transient work, so none of
// it is. The hook itself is mocked; backupStore.test.ts owns the store.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { MumblerCard, PendingImportReviewItem } from "@shared/app-shell";

const { backupRecord } = vi.hoisted(() => ({ backupRecord: vi.fn() }));
vi.mock("@main/core/backupStore", () => ({ record: backupRecord }));

const { createDefaultSettings, createSettingsStore } = await import("@main/core/settings-schema");
const { QueueStore } = await import("@main/core/queue-store");

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

it("does not record a pending import or a card", async () => {
  const store = new QueueStore({
    cardsDir: join(dir, "cards"), inboxDir: join(dir, "inbox"),
  });
  const card = { id: "take", transcription: { text: "words" }, metadata: { structured: null, title: null, slug: null } } as MumblerCard;
  await store.writeCard(card);
  await store.writeImport({ id: "pending" } as PendingImportReviewItem);
  expect(backupRecord).not.toHaveBeenCalled();
});
