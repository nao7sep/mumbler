import type { MumblerCard } from "@shared/app-shell";

// A single occupied transcription concurrency slot. Each acquisition gets its own
// handle whose release() is idempotent and affects only that handle.
export interface TranscriptionSlot {
  /** Release this slot back to the pool. Only the first call frees a slot. */
  release(): void;
  /** True while this acquisition still occupies a slot. */
  readonly held: boolean;
}

// Caps how many transcription jobs run at once. Ownership is per-acquisition, not
// per-card: acquire() hands back an independent handle, so a detached or cancelled
// pipeline releasing its own slot can never free the slot a *replacement* pipeline
// holds — even when both are for the same card. The pool only counts occupied
// slots; deciding when to acquire/release belongs to the caller.
export class TranscriptionSlotPool {
  private readonly slots = new Set<TranscriptionSlot>();

  get inUse(): number {
    return this.slots.size;
  }

  acquire(): TranscriptionSlot {
    let active = true;
    const slot: TranscriptionSlot = {
      get held(): boolean {
        return active;
      },
      release: (): void => {
        if (!active) {
          return;
        }
        active = false;
        this.slots.delete(slot);
      },
    };
    this.slots.add(slot);
    return slot;
  }
}

// Picks the earliest-queued card eligible to start, skipping any card that already
// has an active pipeline run. The skip is what lets one drain pass fill several
// free slots at once: a card's status flips from "Queued" to "Transcribing" only
// asynchronously, inside its pipeline, so without this exclusion the loop would
// re-select a card it just spawned and start it twice (or spin).
export function selectNextQueuedCard(
  cards: MumblerCard[],
  activeCardIds: ReadonlySet<string>,
): MumblerCard | null {
  let earliest: MumblerCard | null = null;
  let earliestQueuedAt = Number.POSITIVE_INFINITY;

  for (const card of cards) {
    if (
      card.status !== "Queued" ||
      card.queuedMode === null ||
      card.queuedAtUtc === null ||
      activeCardIds.has(card.id)
    ) {
      continue;
    }

    // Strict `<` keeps the first-seen card on a queuedAtUtc tie, matching the
    // stable ordering of the previous sort-based selection. The card's
    // queuedAtUtc is a plain number here (the guard above excluded null), so the
    // comparison needs no fallback.
    if (card.queuedAtUtc < earliestQueuedAt) {
      earliest = card;
      earliestQueuedAt = card.queuedAtUtc;
    }
  }

  return earliest;
}
