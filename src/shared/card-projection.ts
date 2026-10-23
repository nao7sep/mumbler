import type { AppSnapshot, CardBody, CardMetadata, CardSummary, MumblerCard, MumblerQueue, QueueMetadata, ShellSnapshot } from "./app-shell";

export function cardMetadata(entry: MumblerCard | CardMetadata): CardMetadata {
  const { transcription: _text, metadata, ...card } = entry as CardMetadata & { transcription?: MumblerCard["transcription"] };
  return { ...card, metadata: { title: metadata.title, slug: metadata.slug } };
}

// Strings are immutable. Retain their references and give changed body pairs a
// session revision; metadata captures never clone or transfer those strings.
export class CardProjection {
  private revision = 0;
  private readonly bodies = new Map<string, CardBody>();

  body(card: MumblerCard): CardBody {
    const previous = this.bodies.get(card.id);
    if (previous?.transcription === card.transcription.text && previous.structured === card.metadata.structured) return previous;
    const body: CardBody = Object.freeze({ cardId: card.id, revision: ++this.revision,
      transcription: card.transcription.text, structured: card.metadata.structured,
      hasTranscription: (card.transcription.text ?? "").trim().length > 0,
      hasStructured: (card.metadata.structured ?? "").trim().length > 0 });
    this.bodies.set(card.id, body);
    return body;
  }

  private retain(cards: readonly MumblerCard[]): void {
    const ids = new Set(cards.map((card) => card.id));
    for (const id of this.bodies.keys()) if (!ids.has(id)) this.bodies.delete(id);
  }

  snapshot(snapshot: AppSnapshot): ShellSnapshot {
    this.retain(snapshot.state?.cards ?? []);
    return { ...snapshot, state: snapshot.state === null ? null : {
      pendingImports: snapshot.state.pendingImports,
      cards: snapshot.state.cards.map((card): CardSummary => {
        const body = this.body(card);
        return { ...cardMetadata(card), bodyRevision: body.revision,
          hasTranscription: body.hasTranscription,
          hasStructured: body.hasStructured };
      }),
    } };
  }

  persistence(state: MumblerQueue): { queue: QueueMetadata; bodies: readonly CardBody[] } {
    this.retain(state.cards);
    return {
      queue: structuredClone({ pendingImports: state.pendingImports, cards: state.cards.map(cardMetadata) }),
      bodies: state.cards.map((card) => this.body(card)),
    };
  }
}
