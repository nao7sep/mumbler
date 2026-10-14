import type { ReactElement } from "react";

import type { MumblerCard } from "@shared/app-shell";
import type { Message } from "@shared/i18n/translate";

import { cardErrorMessage } from "./card-status";

import { InlineError } from "./InlineResult";
import { useI18n } from "../i18n/I18nContext";

export interface CardActionError {
  cardId: string;
  operation: string;
  message: Message;
}

export function CardActionResults({
  cardId,
  results,
  onDismiss,
}: {
  cardId: string;
  results: CardActionError[];
  onDismiss: (operation: string) => void;
}): ReactElement | null {
  const i18n = useI18n();
  const ownedResults = results.filter((result) => result.cardId === cardId);
  if (ownedResults.length === 0) {
    return null;
  }

  return (
    <div className="card-action-results">
      {ownedResults.map((result) => (
        <InlineError key={result.operation} onDismiss={() => onDismiss(result.operation)}>
          {i18n.text(result.message)}
        </InlineError>
      ))}
    </div>
  );
}

// The selected card's whole error and the provider's reason, which its queue
// row shortens to one line (interface-styling-conventions, Labels); the row
// carries the announcement, so this repeats none.
export function CardErrorDetail({ card }: { card: MumblerCard }): ReactElement | null {
  const i18n = useI18n();
  const summary = cardErrorMessage(card);
  if (summary === null) return null;
  return (
    <div className="inline-result inline-result--error card-error">
      <div className="inline-result__message">
        {i18n.text(summary)}
        {card.lastError?.providerReason ? <div className="card-error__reason">{card.lastError.providerReason}</div> : null}
      </div>
    </div>
  );
}
