import { readFile } from "node:fs/promises";
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

/**
 * The queue as its files hold it, read without the store's startup settling
 * (which removes unlisted folders and rewrites recovered cards): the cards in
 * queue.json's order, each from its card.json, and inbox.json's pending
 * imports. UTC instants stay the ISO text the files hold.
 */
export async function readSavedQueue(paths: Pick<AppPaths, "queuePath" | "inboxPath" | "cardsDir">): Promise<{
  cards: MumblerCard[];
  pendingImports: PendingImportReviewItem[];
}> {
  const order = await readJson(paths.queuePath);
  const inbox = await readJson(paths.inboxPath);
  const cards: MumblerCard[] = [];
  for (const id of (order?.cardIds ?? []) as string[]) {
    const card = await readJson(join(paths.cardsDir, id, "card.json"));
    if (card !== undefined) cards.push(card as unknown as MumblerCard);
  }
  return { cards, pendingImports: (inbox?.pendingImports ?? []) as PendingImportReviewItem[] };
}
