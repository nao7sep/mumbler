import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { AppPaths, MumblerCard, PendingImportReviewItem } from "@shared/app-shell";

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readItems(directory: string, file: string): Promise<Record<string, unknown>[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const items: Record<string, unknown>[] = [];
  for (const name of names.filter((entry) => !entry.startsWith(".")).sort()) {
    const item = await readJson(join(directory, name, file));
    if (item !== undefined) items.push(item);
  }
  return items;
}

const instant = (value: unknown) => (typeof value === "string" ? Date.parse(value) : Number(value));

/**
 * The queue as its files hold it, read without the store's startup settling
 * (which rewrites recovered cards and clears leftovers): each card from its
 * card.json, by effective time, and each pending import from its import.json,
 * by when it was imported. UTC instants stay the ISO text the files hold.
 */
export async function readSavedQueue(paths: Pick<AppPaths, "cardsDir" | "inboxDir">): Promise<{
  cards: MumblerCard[];
  pendingImports: PendingImportReviewItem[];
}> {
  const cards = (await readItems(paths.cardsDir, "card.json")).sort((left, right) =>
    instant((left.timestamps as Record<string, unknown>).effectiveUtc) - instant((right.timestamps as Record<string, unknown>).effectiveUtc) ||
    instant(left.createdAtUtc) - instant(right.createdAtUtc));
  const pendingImports = (await readItems(paths.inboxDir, "import.json")).sort((left, right) =>
    instant(left.createdAtUtc) - instant(right.createdAtUtc));
  return { cards: cards as unknown as MumblerCard[], pendingImports: pendingImports as unknown as PendingImportReviewItem[] };
}
