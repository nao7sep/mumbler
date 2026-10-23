// The queue is one composite listbox (per the composite-control conventions),
// realized through `useQueueListbox`: it supplies the `role="listbox"`/`option`,
// `aria-selected`, roving tabindex, focus-follow, and list-owned navigation.
// Type-ahead is consciously ceded because the queue's single-letter keys
// (F/B/T/S) are app commands.
import type { ReactElement } from "react";

import type { CardStatus, MumblerCard } from "@shared/app-shell";
import { cardErrorMessage, formatCardStatusMessage, isCardBusy } from "./card-status";
import { CloseIcon } from "./Icon";
import { useI18n } from "../i18n/I18nContext";
import { useQueueListbox } from "./useQueueListbox";

export function slugify(value: string): string {
  return value.toLowerCase().replaceAll(" ", "-");
}

export function statusModifier(status: CardStatus): string {
  return slugify(status);
}

// A recording's length as a timecode (m:ss.t), the same form the trim markers
// are typed in.
export function formatDuration(value: number): string {
  const totalTenths = Math.round(value * 10);
  const totalSeconds = Math.floor(totalTenths / 10);
  const tenths = totalTenths % 10;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}.${tenths}`;
}

export interface QueueListProps {
  cards: Pick<MumblerCard, "id" | "originalFilename" | "timestamps" | "durationSec" | "status" | "activeStep" | "lastError">[];
  selectedCardId: string | null;
  onSelect: (cardId: string) => void;
  /** Asks to remove a card; its × is disabled while the card is busy. */
  onRequestRemove: (cardId: string) => void;
  /** Cards with work running that their status does not show yet. */
  busyCardIds?: readonly string[];
}

export function QueueList({ cards, selectedCardId, onSelect, onRequestRemove, busyCardIds = [] }: QueueListProps): ReactElement {
  const { t, text } = useI18n();
  const { containerProps, getOptionProps } = useQueueListbox({
    cardIds: cards.map((card) => card.id),
    selectedCardId,
    label: t("queue.title"),
  });

  return (
    <div className="queue-list" {...containerProps}>
      {cards.map((card) => (
        <div
          key={card.id}
          {...getOptionProps(card.id)}
          className={`queue-row queue-row--${statusModifier(card.status)}${card.id === selectedCardId ? " queue-row--selected" : ""}`}
          onClick={() => onSelect(card.id)}
          onFocus={() => {
            if (card.id !== selectedCardId) onSelect(card.id);
          }}
        >
          <div className="queue-row__head">
            <strong className="queue-row__filename">{card.originalFilename}</strong>
            {/* Pointer-only, so the row stays one tab stop: Delete or Backspace
                is its keyboard route (composite-control-conventions). */}
            <button
              type="button"
              tabIndex={-1}
              className="result-close queue-row__remove"
              aria-label={t("queue.removeRecording", { file: card.originalFilename })}
              disabled={isCardBusy(card) || busyCardIds.includes(card.id)}
              onClick={(event) => {
                event.stopPropagation();
                onRequestRemove(card.id);
              }}
            >
              <CloseIcon />
            </button>
          </div>
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
            {text(formatCardStatusMessage(card))}
          </div>
          {card.lastError ? (
            <div
              className="queue-row__error"
              role={card.status === "Error" ? "alert" : undefined}
              aria-atomic={card.status === "Error" ? "true" : undefined}
            >
              {text(cardErrorMessage(card)!)}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
