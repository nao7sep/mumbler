import { describe, expect, it } from "vitest";

import type { MumblerCard } from "@shared/app-shell";
import {
  TranscriptionSlotPool,
  selectNextQueuedCard,
} from "@main/core/transcription-queue";

describe("TranscriptionSlotPool", () => {
  it("counts slots as they are acquired and released", () => {
    const pool = new TranscriptionSlotPool();
    expect(pool.inUse).toBe(0);

    const a = pool.acquire();
    const b = pool.acquire();
    expect(pool.inUse).toBe(2);
    expect(a.held).toBe(true);

    a.release();
    expect(pool.inUse).toBe(1);
    expect(a.held).toBe(false);

    b.release();
    expect(pool.inUse).toBe(0);
  });

  it("makes release idempotent so a double release frees only one slot", () => {
    const pool = new TranscriptionSlotPool();
    const a = pool.acquire();
    const b = pool.acquire();

    a.release();
    a.release(); // second call must be a no-op

    expect(a.held).toBe(false);
    expect(b.held).toBe(true);
    expect(pool.inUse).toBe(1);
  });

  it("isolates handles so one run releasing never frees another for the same card", () => {
    // Models cancel-then-regenerate: a detached (orphaned) run and its
    // replacement each hold their own slot. When the orphan finally unwinds and
    // releases, the replacement's slot must survive — otherwise the concurrency
    // limit could be exceeded by admitting an extra queued card.
    const pool = new TranscriptionSlotPool();
    const orphan = pool.acquire();
    const replacement = pool.acquire();
    expect(pool.inUse).toBe(2);

    orphan.release();

    expect(pool.inUse).toBe(1);
    expect(replacement.held).toBe(true);
  });

  it("frees capacity for reuse after release", () => {
    const pool = new TranscriptionSlotPool();
    const a = pool.acquire();
    expect(pool.inUse).toBe(1);

    a.release();
    const b = pool.acquire();

    expect(pool.inUse).toBe(1);
    expect(b.held).toBe(true);
  });
});

function makeCard(overrides: Partial<MumblerCard> = {}): MumblerCard {
  return {
    id: "card-1",
    originalFilename: "rec.m4a",
    importSource: "file-picker",
    sourceFilePath: "/tmp/rec.m4a",
    audioProfile: null,
    durationSec: 60,
    fileSizeBytes: 1024,
    timestamps: {
      confirmedLocal: "2026-04-22 09:44:00",
      confirmedUtc: Date.UTC(2026, 3, 22, 0, 44, 0),
      timezone: "Asia/Tokyo",
      frontTrimOffsetSec: 0,
      effectiveLocal: "2026-04-22 09:44:00",
      effectiveUtc: Date.UTC(2026, 3, 22, 0, 44, 0),
    },
    trim: { frontMarkerSec: null, backMarkerSec: null },
    trimDecision: null,
    transcription: { text: null },
    metadata: { structured: null, title: null, slug: null },
    ai: { transcription: null, structured: null, title: null, slug: null },
    status: "Imported",
    activeStep: null,
    queuedMode: null,
    queuedAtUtc: null,
    lastError: null,
    createdAtUtc: 1,
    updatedAtUtc: 1,
    ...overrides,
  };
}

function queuedCard(id: string, queuedAtUtc: number): MumblerCard {
  return makeCard({ id, status: "Queued", queuedMode: "generate", queuedAtUtc });
}

describe("selectNextQueuedCard", () => {
  const none = new Set<string>();

  it("returns null when there are no cards", () => {
    expect(selectNextQueuedCard([], none)).toBeNull();
  });

  it("returns null when no card is queued", () => {
    const cards = [makeCard({ id: "a", status: "Imported" }), makeCard({ id: "b", status: "Ready to Save" })];
    expect(selectNextQueuedCard(cards, none)).toBeNull();
  });

  it("picks the earliest-queued card by queuedAtUtc regardless of array order", () => {
    const cards = [queuedCard("late", 300), queuedCard("early", 100), queuedCard("mid", 200)];
    expect(selectNextQueuedCard(cards, none)?.id).toBe("early");
  });

  it("skips cards that are not in the Queued state", () => {
    const cards = [
      makeCard({ id: "transcribing", status: "Transcribing", queuedMode: "generate", queuedAtUtc: 50 }),
      queuedCard("queued", 100),
    ];
    expect(selectNextQueuedCard(cards, none)?.id).toBe("queued");
  });

  it("skips a card already excluded because it has an active run", () => {
    // The drain registers a run synchronously but the card's status flips to
    // Transcribing only later, inside the pipeline. Excluding active runs is what
    // stops a single drain pass from re-selecting (and double-spawning) the card
    // it just started.
    const cards = [queuedCard("first", 100), queuedCard("second", 200)];
    expect(selectNextQueuedCard(cards, new Set(["first"]))?.id).toBe("second");
  });

  it("returns null when every queued card already has an active run", () => {
    const cards = [queuedCard("first", 100), queuedCard("second", 200)];
    expect(selectNextQueuedCard(cards, new Set(["first", "second"]))).toBeNull();
  });

  it("defensively skips a Queued card missing its queue bookkeeping", () => {
    const cards = [
      makeCard({ id: "broken", status: "Queued", queuedMode: null, queuedAtUtc: null }),
      queuedCard("valid", 100),
    ];
    expect(selectNextQueuedCard(cards, none)?.id).toBe("valid");
  });

  it("keeps the first-seen card when two are queued at the same instant", () => {
    // Stable tie-break: equal queuedAtUtc must not flip the choice between calls,
    // matching the previous stable-sort behavior.
    const cards = [queuedCard("first", 100), queuedCard("second", 100)];
    expect(selectNextQueuedCard(cards, none)?.id).toBe("first");
  });

  it("treats a queuedAtUtc of 0 as a real timestamp, not a missing value", () => {
    // Guards against a falsy-zero regression: 0 is a valid (earliest) timestamp,
    // distinct from the null that means "not queued".
    const cards = [queuedCard("epoch", 0), queuedCard("later", 100)];
    expect(selectNextQueuedCard(cards, none)?.id).toBe("epoch");
  });

  it("drains a multi-card queue in order when selection runs in lockstep", () => {
    // Models tryStartNextQueuedCards: select, mark the chosen card active, repeat.
    // The growing exclusion set is what lets one drain pass fill several slots
    // without re-selecting the card it just started.
    const cards = [queuedCard("c", 300), queuedCard("a", 100), queuedCard("b", 200)];
    const excluded = new Set<string>();
    const order: string[] = [];

    for (
      let next = selectNextQueuedCard(cards, excluded);
      next !== null;
      next = selectNextQueuedCard(cards, excluded)
    ) {
      order.push(next.id);
      excluded.add(next.id);
    }

    expect(order).toEqual(["a", "b", "c"]);
  });
});
