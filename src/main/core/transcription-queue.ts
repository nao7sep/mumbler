import type { MumblerCard } from "@shared/app-shell";

// A single occupied place under Concurrent transcriptions. Each acquisition gets its own
// handle whose release() is idempotent and affects only that handle.
export interface TranscriptionSlot {
  /** Release this slot back to the pool. Only the first call frees a slot. */
  release(): void;
  /** True while this acquisition still occupies a slot. */
  readonly held: boolean;
}

// Counts the places runs hold under Concurrent transcriptions. Ownership is per-acquisition, not
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

// Picks the earliest-queued card. A started card leaves Queued in the same
// command that starts it, so a drain never selects it twice.
export function selectNextQueuedCard(cards: MumblerCard[]): MumblerCard | null {
  let earliest: MumblerCard | null = null;
  let earliestQueuedAt = Number.POSITIVE_INFINITY;

  for (const card of cards) {
    if (card.status !== "Queued" || card.queuedMode === null || card.queuedAtUtc === null) {
      continue;
    }

    // Strict `<` keeps the first-seen card on a queuedAtUtc tie.
    if (card.queuedAtUtc < earliestQueuedAt) {
      earliest = card;
      earliestQueuedAt = card.queuedAtUtc;
    }
  }

  return earliest;
}
