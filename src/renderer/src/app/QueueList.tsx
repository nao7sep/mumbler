import type { ReactElement } from "react";

import type { CardStatus, MumblerCard } from "@shared/app-shell";
import { formatCardStatusMessage } from "./card-status";

export function slugify(value: string): string {
  return value.toLowerCase().replaceAll(" ", "-");
}

export function statusModifier(status: CardStatus): string {
  return slugify(status);
}

export function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }

  const units = ["KB", "MB", "GB"];
  let size = value / 1024;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[unitIndex]}`;
}

export function formatDuration(value: number | null): string {
  if (value === null) {
    return "Unknown";
  }

  const totalTenths = Math.round(value * 10);
  const totalSeconds = Math.floor(totalTenths / 10);
  const tenths = totalTenths % 10;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}.${tenths}`;
}

export interface QueueListProps {
  cards: MumblerCard[];
  selectedCardId: string | null;
  onSelect: (cardId: string) => void;
}

export function QueueList({ cards, selectedCardId, onSelect }: QueueListProps): ReactElement {
  return (
    <div className="queue-list">
      {cards.map((card) => (
        <button
          key={card.id}
          type="button"
          className={`queue-row queue-row--${statusModifier(card.status)}${card.id === selectedCardId ? " queue-row--selected" : ""}`}
          onClick={() => onSelect(card.id)}
        >
          <strong className="queue-row__filename">{card.originalFilename}</strong>
          <div className="queue-row__meta">
            <span>{card.timestamps.effectiveLocal}</span>
            {card.durationSec !== null ? (
              <>
                <span className="queue-row__dot">·</span>
                <span>{formatDuration(card.durationSec)}</span>
              </>
            ) : null}
          </div>
          <div className={`queue-row__status status-text status-text--${slugify(card.status)}`}>
            {formatCardStatusMessage(card)}
          </div>
          {card.lastError ? (
            <div className="queue-row__error">{card.lastError.message}</div>
          ) : null}
        </button>
      ))}
    </div>
  );
}
