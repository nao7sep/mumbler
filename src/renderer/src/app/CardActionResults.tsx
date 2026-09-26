import type { ReactElement } from "react";

import type { Message } from "@shared/i18n/translate";

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
