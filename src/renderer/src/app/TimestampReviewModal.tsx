import { useMemo, useState, type ReactElement } from "react";

import type { PendingImportReviewItem } from "@shared/app-shell";
import {
  getLocalTimestampError,
  getUtcTimestampError,
  isSupportedTimezone,
  recomputeLocalFromUtc,
  recomputeUtcFromLocal,
} from "@shared/timestamps";

export interface TimestampReviewModalProps {
  items: PendingImportReviewItem[];
  onChange: (item: PendingImportReviewItem) => void;
  onApplyTimezoneToAll: (timezone: string) => void;
  onSetDeleteOriginalForAll: (value: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
  isSubmitting: boolean;
}

export function TimestampReviewModal({
  items,
  onChange,
  onApplyTimezoneToAll,
  onSetDeleteOriginalForAll,
  onConfirm,
  onCancel,
  isSubmitting,
}: TimestampReviewModalProps): ReactElement {
  const [bulkTimezone, setBulkTimezone] = useState("");

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
        </div>

        <div className="modal-toolbar">
          <label className="field">
            <span>Set all timezones to</span>
            <input
              value={bulkTimezone}
              onChange={(event) => setBulkTimezone(event.target.value)}
              placeholder="Asia/Tokyo"
            />
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
          {items.map((item, index) => {
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
                            utcResult.error === null ? utcResult.utcTimestampText : item.utcTimestampText,
                        });
                      }}
                    />
                  </label>
                  <label className="field">
                    <span>Timezone</span>
                    <input
                      value={item.timezone}
                      onChange={(event) => {
                        const timezone = event.target.value;
                        if (getLocalTimestampError(item.localTimestampText) === null) {
                          const utcResult = recomputeUtcFromLocal(item.localTimestampText, timezone);
                          onChange({
                            ...item,
                            timezone,
                            utcTimestampText:
                              utcResult.error === null ? utcResult.utcTimestampText : item.utcTimestampText,
                          });
                          return;
                        }

                        if (getUtcTimestampError(item.utcTimestampText) === null) {
                          const localResult = recomputeLocalFromUtc(item.utcTimestampText, timezone);
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
                    />
                  </label>
                  <label className="field">
                    <span>UTC timestamp</span>
                    <input
                      value={item.utcTimestampText}
                      onChange={(event) => {
                        const nextValue = event.target.value.toLowerCase();
                        const localResult = recomputeLocalFromUtc(nextValue, item.timezone);
                        onChange({
                          ...item,
                          utcTimestampText: nextValue,
                          localTimestampText:
                            localResult.error === null ? localResult.localTimestampText : item.localTimestampText,
                        });
                      }}
                    />
                  </label>
                </div>
                <div className="review-row__footer">
                  <span className="review-row__index">#{index + 1}</span>
                  {rowError ? <span className="row-error">{rowError}</span> : null}
                </div>
              </div>
            );
          })}
        </div>

        <div className="modal-actions">          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', marginRight: 'auto' }}>
            <input
              type="checkbox"
              checked={items.length > 0 && items.every((i) => i.deleteOriginalOnConfirm)}
              onChange={(e) => onSetDeleteOriginalForAll(e.target.checked)}
            />
            Delete originals after import
          </label>
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

