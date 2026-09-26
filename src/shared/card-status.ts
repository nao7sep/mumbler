import type { CardTrim, MumblerCard } from "./app-shell";

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

function sameTrim(left: CardTrim, right: CardTrim): boolean {
  return left.frontMarkerSec === right.frontMarkerSec && left.backMarkerSec === right.backMarkerSec;
}

// Whether the card's AI results describe a span other than the current trim: the
// markers moved after the transcription was made. A trim keeps the results
// rather than clearing them, so this is how both the renderer and a reader of
// the card tell that they may no longer match the audio.
export function hasStaleResults(card: MumblerCard): boolean {
  return card.transcribedTrim !== null && !sameTrim(card.transcribedTrim, card.trim);
}
