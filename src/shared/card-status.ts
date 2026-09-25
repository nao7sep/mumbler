import type { MumblerCard } from "./app-shell";

// The single "is this card busy?" predicate, shared by the main process (the
// mutation guards in app-runtime) and the renderer (control disabling). A card
// is busy from the moment it is queued: a "Queued" card is one drain pass away
// from a pipeline holding its working file, so every guard that protects a
// mutation against a running pipeline must also refuse a queued one. Main and
// renderer both import this function rather than spelling the status set out,
// so the two sides can never disagree on what busy means. A card being saved is
// busy too: the save reads its results and then deletes its working audio, so no
// generation, trim, removal or second save may start underneath it.
export function isCardBusy(card: MumblerCard): boolean {
  return (
    card.status === "Queued" ||
    card.status === "Transcribing" ||
    card.status === "Generating Metadata" ||
    card.status === "Saving"
  );
}
