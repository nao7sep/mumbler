import { useMemo, useState, type ReactElement } from "react";

import type { PendingImportReviewItem } from "@shared/app-shell";
import {
  formatUtcForDisplay,
  getLocalTimestampError,
  getSupportedTimezones,
  getUtcTimestampError,
  isSupportedTimezone,
  parseUtcFromDisplay,
  recomputeLocalFromUtc,
  recomputeUtcFromLocal,
} from "@shared/timestamps";

export interface TimestampReviewModalProps {
  items: PendingImportReviewItem[];
  defaultTimezone?: string;
  onChange: (item: PendingImportReviewItem) => void;
  onApplyTimezoneToAll: (timezone: string) => void;
  onSetDeleteOriginalForAll: (value: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
  isSubmitting: boolean;
}

export function TimestampReviewModal({
  items,
  defaultTimezone,
  onChange,
  onApplyTimezoneToAll,
  onSetDeleteOriginalForAll,
  onConfirm,
  onCancel,
  isSubmitting,
}: TimestampReviewModalProps): ReactElement {
  const [bulkTimezone, setBulkTimezone] = useState(defaultTimezone ?? "");

  const timezoneOptions = useMemo(() => getSupportedTimezones(), []);

  const validationErrors = useMemo(
    () =>
      items.map((item) => {
        const timezoneError = isSupportedTimezone(item.timezone)
          ? null
          : "Enter a valid IANA timezone.";
        return (
          timezoneError ??
          getLocalTimestampError(item.localTimestampText) ??
          getUtcTimestampError(item.utcTimestampText)
        );
      }),
    [items],
  );

  const isConfirmDisabled = validationErrors.some((error) => error !== null);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <section className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-card__header">
          <h2>Timestamp Review</h2>
          <button
            type="button"
            className="button button--ghost button--compact modal-close"
            onClick={onCancel}
            disabled={isSubmitting}
          >
            ✕
          </button>
        </div>

        <div className="modal-toolbar">
          <label className="field">
            <span>Set all timezones to</span>
            <select
              value={bulkTimezone}
              onChange={(event) => setBulkTimezone(event.target.value)}
            >
              <option value="">— select —</option>
              {timezoneOptions.map((tz) => (
                <option key={tz} value={tz}>{tz}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="button button--ghost"
            onClick={() => onApplyTimezoneToAll(bulkTimezone)}
            disabled={bulkTimezone.trim().length === 0}
          >
            Apply to All
          </button>
        </div>

        <div className="review-table">
          {items.map((item) => {
            const timezoneError = isSupportedTimezone(item.timezone)
              ? null
              : "Enter a valid IANA timezone.";
            const localError = getLocalTimestampError(item.localTimestampText);
            const utcError = getUtcTimestampError(item.utcTimestampText);
            const rowError = timezoneError ?? localError ?? utcError;

            return (
              <div key={item.id} className="review-row">
                <div className="review-row__title">
                  <strong>{item.originalFilename}</strong>
                </div>
                <div className="review-row__fields">
                  <label className="field">
                    <span>Local timestamp</span>
                    <input
                      value={item.localTimestampText}
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        const utcResult = recomputeUtcFromLocal(nextValue, item.timezone);
                        onChange({
                          ...item,
                          localTimestampText: nextValue,
                          utcTimestampText:
                            utcResult.error === null ? formatUtcForDisplay(utcResult.utcMs!) : item.utcTimestampText,
                        });
                      }}
                    />
                  </label>
                  <label className="field">
                    <span>Timezone</span>
                    <select
                      value={item.timezone}
                      onChange={(event) => {
                        const timezone = event.target.value;
                        if (getLocalTimestampError(item.localTimestampText) === null) {
                          const utcResult = recomputeUtcFromLocal(item.localTimestampText, timezone);
                          onChange({
                            ...item,
                            timezone,
                            utcTimestampText:
                              utcResult.error === null ? formatUtcForDisplay(utcResult.utcMs!) : item.utcTimestampText,
                          });
                          return;
                        }

                        if (getUtcTimestampError(item.utcTimestampText) === null) {
                          const utcMs = parseUtcFromDisplay(item.utcTimestampText)!;
                          const localResult = recomputeLocalFromUtc(utcMs, timezone);
                          onChange({
                            ...item,
                            timezone,
                            localTimestampText:
                              localResult.error === null ? localResult.localTimestampText : item.localTimestampText,
                          });
                          return;
                        }

                        onChange({ ...item, timezone });
                      }}
                    >
                      {timezoneOptions.map((tz) => (
                        <option key={tz} value={tz}>{tz}</option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>UTC timestamp</span>
                    <input
                      value={item.utcTimestampText}
                      onChange={(event) => {
                        const nextDisplay = event.target.value;
                        const nextMs = parseUtcFromDisplay(nextDisplay);
                        const nextUtcTimestampText = nextMs !== null ? formatUtcForDisplay(nextMs) : nextDisplay;
                        const localResult = nextMs !== null
                          ? recomputeLocalFromUtc(nextMs, item.timezone)
                          : { localTimestampText: item.localTimestampText, error: "invalid" };
                        onChange({
                          ...item,
                          utcTimestampText: nextUtcTimestampText,
                          localTimestampText:
                            localResult.error === null ? localResult.localTimestampText : item.localTimestampText,
                        });
                      }}
                    />
                  </label>
                </div>
                <div className="review-row__footer">
                  {rowError ? <span className="row-error">{rowError}</span> : null}
                </div>
              </div>
            );
          })}
        </div>

        <div className="modal-footer-note">
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <input
              type="checkbox"
              checked={items.length > 0 && items.every((i) => i.deleteOriginalOnConfirm)}
              onChange={(e) => onSetDeleteOriginalForAll(e.target.checked)}
            />
            Move originals to trash after import
          </label>
          <p className="field-hint">
            Working copies also move to trash when you remove cards — redundant copies are better than none.
          </p>
        </div>

        <div className="modal-actions">
          <button
            type="button"
            className="button button--ghost"
            onClick={onCancel}
            disabled={isSubmitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={onConfirm}
            disabled={isConfirmDisabled || isSubmitting}
          >
            {isSubmitting ? "Confirming…" : "Confirm"}
          </button>
        </div>

      </section>
    </div>
  );
}

