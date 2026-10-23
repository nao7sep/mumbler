import { afterEach, expect, it, vi } from "vitest";
import type { AppSnapshot, MumblerCard } from "@shared/app-shell";
import { CardProjection } from "@shared/card-projection";

afterEach(() => vi.restoreAllMocks());
function card(id: string): MumblerCard {
  return { id, transcription: { text: "long transcript".repeat(100_000) },
    metadata: { structured: "long outline".repeat(100_000), title: "Title", slug: "title" },
    trim: { frontMarkerSec: 1, backMarkerSec: 5 }, status: "Ready to Save" } as MumblerCard;
}

it("clones metadata only and retains immutable bodies across status and selection updates", () => {
  const projection = new CardProjection();
  const first = card("first");
  const second = card("second");
  const state = { cards: [first, second], pendingImports: [] };
  const clone = vi.spyOn(globalThis, "structuredClone");
  const packet = projection.persistence(state);
  expect(clone).toHaveBeenCalledOnce();
  expect(JSON.stringify(clone.mock.calls[0][0])).not.toContain("long transcript");
  expect(JSON.stringify(clone.mock.calls[0][0])).not.toContain("long outline");
  expect(packet.queue.cards[0]).not.toHaveProperty("transcription");
  expect(packet.queue.cards[0].metadata).not.toHaveProperty("structured");
  first.status = "Queued";
  first.trim.frontMarkerSec = 2;
  const newer = projection.persistence(state);
  expect(newer.bodies[0]).toBe(packet.bodies[0]);
  expect(newer.bodies[1]).toBe(packet.bodies[1]);
  expect(packet.queue.cards[0].status).toBe("Ready to Save");
  expect(packet.queue.cards[0].trim.frontMarkerSec).toBe(1);
  first.transcription.text = null;
  first.metadata.structured = null;
  const cleared = projection.persistence(state);
  expect(cleared.bodies[0].revision).toBeGreaterThan(packet.bodies[0].revision);
  expect(cleared.bodies[0]).toMatchObject({ transcription: null, structured: null });
  expect(packet.bodies[0].transcription).toContain("long transcript");
  expect(cleared.bodies[1]).toBe(packet.bodies[1]);
});

it("projects every card without bodies and retires removed identities without reusing a revision", () => {
  const projection = new CardProjection();
  const first = card("first");
  const second = card("second");
  const snapshot = { state: { cards: [first, second], pendingImports: [] } } as unknown as AppSnapshot;
  const initial = projection.snapshot(snapshot);
  expect(JSON.stringify(initial).length).toBeLessThan(1000);
  expect(initial.state!.cards[0]).toMatchObject({ hasTranscription: true, hasStructured: true });
  snapshot.state!.cards.reverse();
  const reordered = projection.snapshot(snapshot);
  expect(reordered.state!.cards.map((card) => card.bodyRevision)).toEqual(initial.state!.cards.map((card) => card.bodyRevision).reverse());
  snapshot.state!.cards = [second];
  expect(projection.snapshot(snapshot).state!.cards.map((card) => card.id)).toEqual(["second"]);
  snapshot.state!.cards.push(first);
  expect(projection.snapshot(snapshot).state!.cards[1].bodyRevision).toBeGreaterThan(initial.state!.cards[0].bodyRevision);
});
