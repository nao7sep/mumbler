import type { PendingImportReviewItem } from "@shared/app-shell";

// The pure decisions behind useImportFlow, lifted out of the hook so they are
// testable without a DOM drag event or a React effect.

/**
 * The non-empty absolute paths of a set of dropped files, resolved through the
 * preload bridge's `getPathForFile`. Files that resolve to an empty path (no
 * real path available) are dropped.
 */
export function parseDroppedPaths(
  files: ArrayLike<File>,
  getPathForFile: (file: File) => string,
): string[] {
  return Array.from(files)
    .map((file) => getPathForFile(file))
    .filter((value) => value.length > 0);
}

/**
 * Reconcile the local in-review drafts against a fresh snapshot's pending
 * imports: keep the user's local edits when the *set of items is unchanged*,
 * otherwise adopt the snapshot. The identity check is the id list joined in
 * order, so it is deliberately order-sensitive and — to protect an in-flight
 * timestamp edit from being clobbered by a snapshot echo — does NOT re-adopt a
 * same-id snapshot whose item *content* changed. Both are accepted trade-offs of
 * preferring the user's edits while the item set holds steady.
 */
export function reconcilePendingReviewDrafts(
  current: PendingImportReviewItem[],
  snapshotImports: PendingImportReviewItem[],
): PendingImportReviewItem[] {
  const currentIds = current.map((item) => item.id).join("|");
  const snapshotIds = snapshotImports.map((item) => item.id).join("|");
  if (currentIds === snapshotIds && current.length > 0) {
    return current;
  }
  return snapshotImports;
}
