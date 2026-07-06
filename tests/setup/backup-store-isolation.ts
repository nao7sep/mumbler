/**
 * Global test isolation for the write-through backup store (data-backup conventions).
 *
 * Every managed-text save now records the exact bytes it wrote into `backups.sqlite3` under the resolved
 * storage root (`MUMBLER_HOME` or `~/.mumbler`). Without isolation, a unit test that calls `store.save()` /
 * `writeJsonFile()` would open and write the developer's REAL `~/.mumbler/backups.sqlite3`. Two moves, the
 * reference's test-migration, prevent that:
 *
 *  - Point `MUMBLER_HOME` at a fresh throwaway directory before each test, so the store opens under a
 *    per-test root instead of the real home. Any `backups.sqlite3` (+ `-wal`/`-shm`) it creates lands there
 *    and is removed with the root after the test.
 *  - Close the store singleton after each test, so the next test re-opens against its own `MUMBLER_HOME`
 *    rather than holding a handle to the previous test's (now deleted) root.
 *
 * This runs for every test file via `setupFiles` in the vitest config — the one place the isolation lives —
 * so no individual test has to remember it, and a test that never records simply gets a harmless unused
 * throwaway root. A test that wants a specific root still sets `MUMBLER_HOME` itself in its own
 * `beforeEach`; that assignment wins because it runs after this one, and this file's `afterEach` still
 * closes the store and clears the override.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach } from "vitest";

import { closeBackupStore } from "@main/core/backupStore";

let root: string | null = null;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mumbler-backup-home-"));
  process.env.MUMBLER_HOME = root;
});

afterEach(async () => {
  // Release the SQLite file handle first, so the singleton re-opens against the next test's MUMBLER_HOME
  // and the throwaway root can be removed on every platform.
  closeBackupStore();
  delete process.env.MUMBLER_HOME;
  if (root !== null) {
    await rm(root, { recursive: true, force: true });
    root = null;
  }
});
