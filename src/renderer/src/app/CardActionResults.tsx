import type { ReactElement } from "react";

import { InlineError } from "./InlineResult";

export interface CardActionError {
  cardId: string;
  operation: string;
  message: string;
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
  const ownedResults = results.filter((result) => result.cardId === cardId);
  if (ownedResults.length === 0) {
    return null;
  }

  return (
    <div className="card-action-results">
      {ownedResults.map((result) => (
        <InlineError key={result.operation} onDismiss={() => onDismiss(result.operation)}>
          {result.message}
        </InlineError>
      ))}
    </div>
  );
}
