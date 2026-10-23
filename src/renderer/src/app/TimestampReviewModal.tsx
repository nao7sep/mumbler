import { useMemo, useState, type ReactElement } from "react";

import type { PendingImportReviewItem } from "@shared/app-shell";
import {
  formatUtcForDisplay,
  getLocalTimestampError,
  getSupportedTimezones,
  getUtcTimestampError,
  isValidTimezone,
  parseUtcFromDisplay,
  recomputeLocalFromUtc,
  recomputeUtcFromLocal,
} from "@shared/timestamps";

import type { Message } from "@shared/i18n/translate";
import type { MessageKey } from "@shared/i18n/catalogues";

import { changeReviewTimezone } from "@shared/review-timestamps";
import { chooseRecordingTime, foundTimes, isFoundTimeSelected, usesOnlyFileDates } from "./import-rules";
import { InlineError } from "./InlineResult";
import { ModalShell } from "./modal/ModalShell";
import { ShortenedValue } from "./ShortenedValue";
import { useI18n } from "../i18n/I18nContext";

const TIME_SOURCE_LABELS: Record<PendingImportReviewItem["timeCandidates"][number]["source"], MessageKey> = {
  "file-name": "review.timeFileName",
  embedded: "review.timeEmbedded",
  "file-created": "review.timeFileCreated",
  "file-modified": "review.timeFileModified",
};

export interface TimestampReviewModalProps {
  items: PendingImportReviewItem[];
  errorMessage: Message | null;
  onDismissError: () => void;
  defaultTimezone?: string;
  backupDirectoryLabel: string | null;
  onChange: (item: PendingImportReviewItem) => void;
  onApplyTimezoneToAll: (timezone: string) => void;
  onSetDeleteOriginalForAll: (value: boolean) => void;
  onSetCopyToBackupForAll: (value: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
  isSubmitting: boolean;
}

export function TimestampReviewModal({
  items,
  errorMessage,
  onDismissError,
  defaultTimezone,
  backupDirectoryLabel,
  onChange,
  onApplyTimezoneToAll,
  onSetDeleteOriginalForAll,
  onSetCopyToBackupForAll,
  onConfirm,
  onCancel,
  isSubmitting,
}: TimestampReviewModalProps): ReactElement {
  const i18n = useI18n();
  const { t } = i18n;
  const [bulkTimezone, setBulkTimezone] = useState(defaultTimezone ?? "");

  const timezoneOptions = useMemo(() => getSupportedTimezones(), []);

  const validationErrors = useMemo(
    () =>
      items.map((item) => {
        const timezoneError = isValidTimezone(item.timezone)
          ? null
          : "timestamp.invalidZone";
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
    <ModalShell
      title={t("review.title")}
      size="default"
      onRequestClose={onCancel}
      closeDisabled={isSubmitting}
      footer={
        <>
          <button
            type="button"
            className="button button--ghost"
            onClick={onCancel}
            disabled={isSubmitting}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={onConfirm}
            disabled={isConfirmDisabled || isSubmitting}
          >
            {isSubmitting ? t("review.confirming") : t("review.confirm")}
          </button>
        </>
      }
    >
        {errorMessage ? <InlineError onDismiss={onDismissError}>{i18n.text(errorMessage)}</InlineError> : null}
        <div className="modal-toolbar">
          <div className="field modal-toolbar__field">
            <span id="bulk-timezone-label">{t("review.setAllZones")}</span>
            <div className="bulk-timezone-controls">
              <select
                aria-labelledby="bulk-timezone-label"
                disabled={isSubmitting}
                value={bulkTimezone}
                onChange={(event) => setBulkTimezone(event.target.value)}
              >
                <option value="">{t("review.selectZone")}</option>
                {timezoneOptions.map((tz) => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
              </select>
              <button
                type="button"
                className="button button--ghost"
                onClick={() => onApplyTimezoneToAll(bulkTimezone)}
                disabled={isSubmitting || bulkTimezone.trim().length === 0}
              >
                {t("review.applyToAll")}
              </button>
            </div>
          </div>
        </div>

        <div className="modal-card__body">
          <div className="review-table">
          {items.map((item) => {
            const timezoneError = isValidTimezone(item.timezone)
              ? null
              : "timestamp.invalidZone";
            const localError = getLocalTimestampError(item.localTimestampText);
            const utcError = getUtcTimestampError(item.utcTimestampText);
            // An empty time is something still to do, not a mistake: it keeps
            // Confirm off without a red error until text that does not parse.
            const untouched = item.localTimestampText.trim() === "" && item.utcTimestampText.trim() === "";
            const rowError = timezoneError ?? (untouched ? null : localError ?? utcError);
            const times = foundTimes(item);

            return (
              <div key={item.id} className="review-row">
                <div className="review-row__title">
                  <strong><ShortenedValue kind="name" value={item.originalFilename} /></strong>
                </div>
                {/* Listening settles a time the file does not state. */}
                <audio
                  className="review-row__player"
                  controls
                  preload="none"
                  src={`mumbler-asset://media/${encodeURIComponent(item.id)}`}
                  aria-label={t("review.listen", { file: item.originalFilename })}
                />
                {/* Each distinct time once, naming every source that found it; the
                    group's own name is for screen readers, the buttons say the rest. */}
                {times.length > 0 ? (
                  <div className="review-row__times" role="group" aria-label={t("review.timesFound")}>
                    {times.map((found) => (
                      <button
                        key={found.key}
                        type="button"
                        className="button button--ghost button--compact"
                        disabled={isSubmitting}
                        aria-pressed={isFoundTimeSelected(item, found)}
                        onClick={() => onChange(chooseRecordingTime(item, found.candidate))}
                      >
                        {t("review.timeChoice", {
                          source: i18n.list(found.sources.map((source) => t(TIME_SOURCE_LABELS[source]))),
                          time: times.some((other) => other.key !== found.key && other.localText === found.localText) && found.utcMs !== null
                            ? `${found.localText} (${formatUtcForDisplay(found.utcMs)} UTC)` : found.localText,
                        })}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="field-hint">{t("review.noTimesFound")}</p>
                )}
                <div className="review-row__fields">
                  <label className="field">
                    <span>{t("review.localTimestamp")}</span>
                    <input
                      disabled={isSubmitting}
                      value={item.localTimestampText}
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        const utcResult = recomputeUtcFromLocal(nextValue, item.timezone);
                        onChange({
                          ...item,
                          localTimestampText: nextValue,
                          timestampBasis: "local",
                          utcTimestampText:
                            utcResult.error === null ? formatUtcForDisplay(utcResult.utcMs!) : item.utcTimestampText,
                        });
                      }}
                    />
                  </label>
                  <label className="field">
                    <span>{t("info.timezone")}</span>
                    <select
                      disabled={isSubmitting}
                      value={item.timezone}
                      onChange={(event) => {
                        onChange(changeReviewTimezone(item, event.target.value));
                      }}
                    >
                      {timezoneOptions.map((tz) => (
                        <option key={tz} value={tz}>{tz}</option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>{t("review.utcTimestamp")}</span>
                    <input
                      disabled={isSubmitting}
                      value={item.utcTimestampText}
                      onChange={(event) => {
                        const nextDisplay = event.target.value;
                        const nextMs = parseUtcFromDisplay(nextDisplay);
                        const localResult = nextMs !== null
                          ? recomputeLocalFromUtc(nextMs, item.timezone)
                          : { localTimestampText: item.localTimestampText, error: "timestamp.utcFormat" as const };
                        onChange({
                          ...item,
                          // Keep the user's raw keystrokes in the field they are
                          // editing — reformatting it mid-edit would yank the caret.
                          // Canonicalization happens at confirm (buildConfirmedTimestamps).
                          utcTimestampText: nextDisplay,
                          timestampBasis: "utc",
                          localTimestampText:
                            localResult.error === null ? localResult.localTimestampText : item.localTimestampText,
                        });
                      }}
                    />
                  </label>
                </div>
                <div className="review-row__footer">
                  {rowError ? <span className="row-error">{t(rowError)}</span> : null}
                  {usesOnlyFileDates(item) ? <span className="row-caution">{t("review.fileDatesCaution")}</span> : null}
                </div>
              </div>
            );
          })}
        </div>

        </div>

        <div className="modal-footer-note">
          <label className="modal-checkbox">
            <input
              type="checkbox"
              disabled={isSubmitting}
              checked={items.length > 0 && items.every((i) => i.copyToBackupOnConfirm)}
              onChange={(e) => onSetCopyToBackupForAll(e.target.checked)}
            />
            {t("review.copyToBackup")}
          </label>
          <p className="field-hint">
            {backupDirectoryLabel === null
              ? t("settings.backupDirectoryHint", { option: t("review.copyToBackup") })
              : i18n.rich("review.backupHint", { path: <code>{backupDirectoryLabel}</code> })}
          </p>
          <label className="modal-checkbox">
            <input
              type="checkbox"
              disabled={isSubmitting}
              checked={items.length > 0 && items.every((i) => i.deleteOriginalOnConfirm)}
              onChange={(e) => onSetDeleteOriginalForAll(e.target.checked)}
            />
            {t("review.deleteOriginals")}
          </label>
          <p className="field-hint">
            {t("review.bothOptionsHint")}
          </p>
        </div>
    </ModalShell>
  );
}
