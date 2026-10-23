interface CardSource { cardId: string; last: string; index: number }

/** A disposable projection of committed facts, owned by the records worker. */
export class RecordSourcesProjection {
  private readonly sessions: string[];
  private readonly sessionSet: Set<string>;
  private readonly cards: CardSource[];
  private readonly byCard: Map<string, CardSource>;

  constructor(sessions: string[], cards: Array<{ cardId: string; last: string }>) {
    this.sessions = sessions;
    this.sessionSet = new Set(sessions);
    this.cards = cards.map((card, index) => ({ ...card, index }));
    this.byCard = new Map(this.cards.map((card) => [card.cardId, card]));
  }

  add(session: string, cardId: string | null, time: string): boolean {
    let changed = false;
    if (!this.sessionSet.has(session)) {
      this.sessionSet.add(session);
      this.sessions.splice(insertionIndex(this.sessions, (value) => value > session), 0, session);
      changed = true;
    }
    if (cardId === null) return changed;
    let card = this.byCard.get(cardId);
    if (card !== undefined && time <= card.last) return changed;
    const oldIndex = card?.index ?? this.cards.length;
    if (card !== undefined) {
      card.last = time;
      // Time only advances. Most writes concern the current first card and
      // leave the visible projection unchanged, requiring no sort or copy.
      if (oldIndex === 0 || before(this.cards[oldIndex - 1]!, card)) return changed;
      this.cards.splice(oldIndex, 1);
    } else {
      card = { cardId, last: time, index: oldIndex };
      this.byCard.set(cardId, card);
    }
    const nextIndex = insertionIndex(this.cards, (value) => before(value, card!));
    this.cards.splice(nextIndex, 0, card);
    for (let index = nextIndex; index <= oldIndex; index++) this.cards[index]!.index = index;
    return true;
  }

  snapshot(): { sessions: string[]; cardIds: string[] } {
    return { sessions: [...this.sessions], cardIds: this.cards.map((card) => card.cardId) };
  }
}

function before(a: CardSource, b: CardSource): boolean {
  return a.last > b.last || (a.last === b.last && a.cardId < b.cardId);
}

function insertionIndex<T>(values: readonly T[], precedes: (value: T) => boolean): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (precedes(values[middle]!)) low = middle + 1;
    else high = middle;
  }
  return low;
}
