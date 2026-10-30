import { useMemo, useRef, useState, type ReactElement } from "react";

import { THEME_PREFERENCES, type SettingsDraft } from "@shared/app-shell";
import { rowFor, thinkingAfterModelEdit } from "@shared/ai-models";
import {
  getSettingsNumberIssues,
  parseWholeNumberText,
  getTimestampPatternIssues,
  type NumericSettingField,
} from "@shared/settings-validation";
import { DEFAULT_TIMESTAMP_PATTERNS, SYSTEM_TIMEZONE, getSupportedTimezones, getSystemTimezone } from "@shared/timestamps";
import { LANGUAGE_NAMES, LANGUAGES, normalizeLanguagePreference, type Language } from "@shared/i18n/languages";
import { useI18n } from "../i18n/I18nContext";
import type { MessageKey } from "@shared/i18n/catalogues";
import { type Message, type Translator } from "@shared/i18n/translate";
import { ModalShell } from "./modal/ModalShell";
import { useTablist } from "./useTablist";
import { ChevronDownIcon, ChevronUpIcon, CloseIcon } from "./Icon";
import { InlineError } from "./InlineResult";

// A whole-number field that keeps exactly what was typed. The draft takes the
// number the text reads as, or NaN when it reads as none (empty, a fraction,
// letters), which the shared rules report and Save refuses. A value replaced
// from outside, such as reopening Settings, replaces the text; the user's own
// typing never does.
function WholeNumberInput({
  value,
  onValue,
  ...aria
}: {
  value: number;
  onValue: (value: number) => void;
  "aria-invalid": true | undefined;
  "aria-describedby": string | undefined;
}): ReactElement {
  const [typed, setTyped] = useState(() => (Number.isNaN(value) ? "" : String(value)));
  const [shown, setShown] = useState(value);
  if (!Object.is(value, shown)) {
    setShown(value);
    if (!Object.is(parseWholeNumberText(typed), value)) setTyped(Number.isNaN(value) ? "" : String(value));
  }
  return (
    <input
      type="text"
      inputMode="numeric"
      value={typed}
      {...aria}
      onChange={(event) => {
        const next = parseWholeNumberText(event.target.value);
        setTyped(event.target.value);
        setShown(next);
        onValue(next);
      }}
    />
  );
}

// One model field: free-typed, with a warning line when the id has no row in
// SUPPORTED_MODELS, and beside it the role's Thinking field per the
// ai-model-routing-conventions.
function ModelField({ label, hint, value, thinking, onChange }: {
  label: string;
  hint: string;
  value: string;
  thinking: string;
  onChange: (value: string, thinking: string) => void;
}): ReactElement {
  const { t } = useI18n();
  const row = rowFor(value);
  const lastListedModel = useRef(value);
  return (
    <>
      <div>
        <label className="field">
          <span>{label}</span>
          <input
            spellCheck={false}
            value={value}
            onChange={(event) => {
              const edit = thinkingAfterModelEdit(lastListedModel.current, event.target.value, thinking);
              lastListedModel.current = edit.lastListedModel;
              onChange(event.target.value, edit.thinking);
            }}
          />
        </label>
        <p className="field-hint">{hint}</p>
        {row ? null : <p className="field-hint field-hint--warning">{t("settings.unsupportedModel")}</p>}
      </div>
      {row && row.thinking.length > 1 ? (
        <div>
          <label className="field">
            <span>{t("settings.thinking")}</span>
            <select value={thinking} onChange={(event) => onChange(value, event.target.value)}>
              {row.thinking.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>
          <p className="field-hint">{t("settings.thinkingHint")}</p>
        </div>
      ) : null}
    </>
  );
}

// The Settings tabs: the four small sections share General, and the AI
// settings split by concern — provider setup (key, models, concurrency) and
// the prompt texts.
const SETTINGS_TABS = ["general", "ai", "prompts"] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number];
const SETTINGS_TAB_LABELS: Record<SettingsTab, MessageKey> = {
  general: "settings.tabGeneral",
  ai: "settings.tabAi",
  prompts: "settings.tabPrompts",
};

/** The language's System entry: the language it resolves to now, named in the
 * interface language, as every System entry names its value there
 * (localization-conventions, Translation). */
export function systemLanguageLabel(i18n: Pick<Translator, "t" | "language">, systemLanguage: Language): string {
  const name = new Intl.DisplayNames([i18n.language], { type: "language" }).of(systemLanguage) ?? LANGUAGE_NAMES[systemLanguage];
  return i18n.t("settings.languageSystem", { language: name });
}

// The rows with one moved from `from` to `to`, for the pattern list's arrows.
function movedRow(rows: readonly string[], from: number, to: number): string[] {
  const next = [...rows];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

export function SettingsModal({
  draft,
  apiKeyInput,
  setApiKeyInput,
  isDirty,
  isSaving,
  isSavingApiKey,
  isPickingOutputDirectory,
  isPickingBackupDirectory,
  errorMessage,
  onChange,
  onClose,
  onPickOutputDirectory,
  onPickBackupDirectory,
  onSetApiKey,
  onClearApiKey,
  onRestoreDefaultPrompts,
  onSave,
  systemLanguage = "en",
  systemTheme = "light",
}: {
  draft: SettingsDraft;
  apiKeyInput: string;
  setApiKeyInput: (value: string) => void;
  isDirty: boolean;
  isSaving: boolean;
  isSavingApiKey: boolean;
  isPickingOutputDirectory: boolean;
  isPickingBackupDirectory: boolean;
  errorMessage: Message | null;
  onChange: (draft: SettingsDraft) => void;
  onClose: () => void;
  onPickOutputDirectory: () => void;
  onPickBackupDirectory: () => void;
  onSetApiKey: (apiKey: string) => void;
  onClearApiKey: () => void;
  onRestoreDefaultPrompts: () => void;
  onSave: () => void;
  // What each System entry resolves to now, which it shows beside "System".
  systemLanguage?: Language;
  systemTheme?: "light" | "dark";
}): ReactElement {
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const settingsTablist = useTablist<SettingsTab>({
    tabs: SETTINGS_TABS,
    selected: activeTab,
    onSelect: setActiveTab,
    idBase: "settings",
  });
  const timezoneOptions = useMemo(() => getSupportedTimezones(), []);
  const systemTimezone = useMemo(() => getSystemTimezone(), []);
  const i18n = useI18n();
  const { t, text } = i18n;
  const numberIssues = useMemo(() => getSettingsNumberIssues(draft), [draft]);
  const patternIssues = useMemo(() => getTimestampPatternIssues(draft.timestampPatterns), [draft.timestampPatterns]);
  const patternIssueRows = new Set(patternIssues.map((issue) => issue.row));
  const canSave = isDirty && numberIssues.length === 0 && patternIssues.length === 0 && !isSaving;
  const numberIssueByField = new Map(numberIssues.map((issue) => [issue.field, issue]));
  const numberFieldProps = (field: NumericSettingField): {
    "aria-invalid": true | undefined;
    "aria-describedby": string | undefined;
  } => ({
    "aria-invalid": numberIssueByField.has(field) ? true : undefined,
    "aria-describedby": numberIssueByField.has(field) ? `settings-number-error-${field}` : undefined,
  });

  return (
    <ModalShell
      title={t("settings.title")}
      size="settings"
      onRequestClose={onClose}
      closeDisabled={isSaving}
      footer={
        <>
          <button type="button" className="button button--ghost" onClick={onClose} disabled={isSaving}>
            {t("common.cancel")}
          </button>
          <button type="button" className="button button--primary" onClick={onSave} disabled={!canSave}>
            {isSaving ? t("common.saving") : t("common.save")}
          </button>
        </>
      }
    >
      {/* Fixed chrome between the modal header and the scrolling body, like the
          other apps' settings tab strips — the tabs never scroll away. */}
      <div className="modal-card__strip">
        <div className="app-tabs settings-tabs" {...settingsTablist.tablistProps} aria-label={t("settings.sections")}>
          {SETTINGS_TABS.map((sectionTab) => (
            <button
              key={sectionTab}
              type="button"
              className={`app-tab${activeTab === sectionTab ? " app-tab--active" : ""}`}
              {...settingsTablist.getTabProps(sectionTab)}
            >
              {t(SETTINGS_TAB_LABELS[sectionTab])}
            </button>
          ))}
        </div>
      </div>

      <div className="modal-card__body">

        {errorMessage ? <InlineError>{text(errorMessage)}</InlineError> : null}

        {numberIssues.length + patternIssues.length > 0 ? (
          <InlineError>
            <ul className="settings-number-errors">
              {numberIssues.map((issue) => (
                <li id={`settings-number-error-${issue.field}`} key={issue.field}>
                  {text(issue.message)}
                </li>
              ))}
              {patternIssues.map((issue) => (
                <li id={issue.row === null ? undefined : `settings-pattern-error-${issue.row}`} key={`pattern-${issue.row}`}>
                  {text(issue.message)}
                </li>
              ))}
            </ul>
          </InlineError>
        ) : null}

        <div className="settings-sections">

          <div className="app-tabpanel" {...settingsTablist.getPanelProps("general")} hidden={activeTab !== "general"}>
            <section className="settings-section">
              <h3 id="settings-language-heading">{t("settings.language")}</h3>
              <div className="field-stack">
                {/* Each language is listed by its own name, in its own script, so a
                    reader of any of them can find it whatever language is showing.
                    Applied on Save with the rest. */}
                <div className="field">
                  <select
                    aria-labelledby="settings-language-heading"
                    value={draft.language}
                    onChange={(event) => onChange({ ...draft, language: normalizeLanguagePreference(event.target.value) })}
                  >
                    <option value="system">{systemLanguageLabel(i18n, systemLanguage)}</option>
                    {LANGUAGES.map((language) => (
                      <option key={language} value={language} lang={language}>
                        {LANGUAGE_NAMES[language]}
                      </option>
                    ))}
                  </select>
                </div>
                <p className="field-hint">{t("settings.languageHint")}</p>
                <label className="field">
                  <span>{t("settings.displayTimezone")}</span>
                  <select
                    value={draft.displayTimezone}
                    onChange={(event) => onChange({ ...draft, displayTimezone: event.target.value })}
                  >
                    <option value={SYSTEM_TIMEZONE}>{t("settings.timezoneSystem", { zone: systemTimezone })}</option>
                    {timezoneOptions.map((tz) => (
                      <option key={tz} value={tz}>{tz}</option>
                    ))}
                  </select>
                </label>
                <p className="field-hint">{t("settings.displayTimezoneHint")}</p>
              </div>
            </section>

            <section className="settings-section">
              <h3>{t("settings.appearance")}</h3>
              <div className="field-stack">
                {/* A native radio group: one tab stop, arrow keys move and select
                    (composite-control conventions). Applied on Save with the rest. */}
                <fieldset className="radio-field">
                  <legend>{t("settings.theme")}</legend>
                  <div className="radio-field__options">
                    {THEME_PREFERENCES.map(({ value, labelKey }) => (
                      <label key={value} className="checkbox-field">
                        <input
                          type="radio"
                          name="theme"
                          value={value}
                          checked={draft.theme === value}
                          onChange={() => onChange({ ...draft, theme: value })}
                        />
                        <span>{value === "system"
                          ? t("settings.themeSystem", { theme: t(systemTheme === "dark" ? "settings.themeDark" : "settings.themeLight") })
                          : t(labelKey)}</span>
                      </label>
                    ))}
                  </div>
                  <p className="field-hint">{t("settings.themeHint")}</p>
                </fieldset>
                <label className="field">
                  <span>{t("settings.uiFont")}</span>
                  <input
                    value={draft.uiFontFamily}
                    placeholder={t("settings.uiFontPlaceholder")}
                    onChange={(event) => onChange({ ...draft, uiFontFamily: event.target.value })}
                  />
                </label>
                <p className="field-hint">
                  {t("settings.uiFontHint")}
                </p>
              </div>
            </section>

            <section className="settings-section">
              <h3>{t("settings.files")}</h3>
              <div className="field-stack">
                {/* Recordings come in before exports go out, so their folder leads. */}
                <label className="field">
                  <span>{t("settings.backupDirectory")}</span>
                  <div className="inline-action-field">
                    <input
                      value={draft.backupDirectory}
                      placeholder={draft.defaultBackupDirectory}
                      onChange={(event) => onChange({ ...draft, backupDirectory: event.target.value })}
                    />
                    <button
                      type="button"
                      className="button button--ghost"
                      onClick={onPickBackupDirectory}
                      disabled={isPickingBackupDirectory}
                    >
                      {t("common.browse")}
                    </button>
                  </div>
                </label>
                <p className="field-hint">
                  {t("settings.backupDirectoryHint", { option: t("review.copyToBackup"), path: draft.defaultBackupDirectory })}
                </p>
                <label className="field">
                  <span>{t("settings.outputDirectory")}</span>
                  <div className="inline-action-field">
                    <input
                      value={draft.outputDirectory}
                      placeholder={draft.defaultOutputDirectory}
                      onChange={(event) => onChange({ ...draft, outputDirectory: event.target.value })}
                    />
                    <button
                      type="button"
                      className="button button--ghost"
                      onClick={onPickOutputDirectory}
                      disabled={isPickingOutputDirectory}
                    >
                      {t("common.browse")}
                    </button>
                  </div>
                </label>
                <p className="field-hint">
                  {t("settings.outputDirectoryHint", { path: draft.defaultOutputDirectory })}
                </p>
              </div>
            </section>

            <section className="settings-section">
              <h3>{t("settings.import")}</h3>
              <div className="field-stack">
                <label className="field">
                  <span>{t("settings.defaultTimezone")}</span>
                  <select
                    value={draft.defaultTimezone}
                    onChange={(event) => onChange({ ...draft, defaultTimezone: event.target.value })}
                  >
                    <option value={SYSTEM_TIMEZONE}>{t("settings.timezoneSystem", { zone: systemTimezone })}</option>
                    {timezoneOptions.map((tz) => (
                      <option key={tz} value={tz}>{tz}</option>
                    ))}
                  </select>
                </label>
                <p className="field-hint">{t("settings.defaultTimezoneHint")}</p>
                <div className="field">
                  <span id="settings-timestamp-patterns-label">{t("settings.timestampPattern")}</span>
                  <ol className="pattern-list" aria-labelledby="settings-timestamp-patterns-label">
                    {draft.timestampPatterns.map((pattern, row) => (
                      <li className="pattern-row" key={row}>
                        <input
                          className="pattern-row__input"
                          spellCheck={false}
                          value={pattern}
                          aria-label={t("settings.timestampPatternRow", { number: row + 1 })}
                          aria-invalid={patternIssueRows.has(row) ? true : undefined}
                          aria-describedby={patternIssueRows.has(row) ? `settings-pattern-error-${row}` : undefined}
                          onChange={(event) => onChange({ ...draft, timestampPatterns: draft.timestampPatterns.map((current, index) => (index === row ? event.target.value : current)) })}
                        />
                        <button
                          type="button"
                          className="button button--ghost button--compact pattern-row__action"
                          aria-label={t("settings.moveTimestampPatternUp", { number: row + 1 })}
                          title={t("settings.moveTimestampPatternUp", { number: row + 1 })}
                          disabled={isSaving || row === 0}
                          onClick={() => onChange({ ...draft, timestampPatterns: movedRow(draft.timestampPatterns, row, row - 1) })}
                        >
                          <ChevronUpIcon />
                        </button>
                        <button
                          type="button"
                          className="button button--ghost button--compact pattern-row__action"
                          aria-label={t("settings.moveTimestampPatternDown", { number: row + 1 })}
                          title={t("settings.moveTimestampPatternDown", { number: row + 1 })}
                          disabled={isSaving || row === draft.timestampPatterns.length - 1}
                          onClick={() => onChange({ ...draft, timestampPatterns: movedRow(draft.timestampPatterns, row, row + 1) })}
                        >
                          <ChevronDownIcon />
                        </button>
                        <button
                          type="button"
                          className="button button--ghost button--compact pattern-row__action"
                          aria-label={t("settings.removeTimestampPattern", { number: row + 1 })}
                          title={t("settings.removeTimestampPattern", { number: row + 1 })}
                          disabled={isSaving}
                          onClick={() => onChange({ ...draft, timestampPatterns: draft.timestampPatterns.filter((_, index) => index !== row) })}
                        >
                          <CloseIcon />
                        </button>
                      </li>
                    ))}
                  </ol>
                  <div>
                    <button
                      type="button"
                      className="button button--ghost button--compact"
                      disabled={isSaving}
                      onClick={() => onChange({ ...draft, timestampPatterns: [...draft.timestampPatterns, ""] })}
                    >
                      {t("settings.addTimestampPattern")}
                    </button>
                  </div>
                </div>
                <p className="field-hint">{i18n.rich("settings.timestampPatternHint", {
                  year: <code>year</code>,
                  month: <code>month</code>,
                  day: <code>day</code>,
                  hour: <code>hour</code>,
                  minute: <code>minute</code>,
                  second: <code>second</code>,
                })}</p>
                <div>
                  <button
                    type="button"
                    className="button button--danger"
                    onClick={() => onChange({ ...draft, timestampPatterns: [...DEFAULT_TIMESTAMP_PATTERNS] })}
                    disabled={isSaving}
                  >
                    {t("settings.resetTimestampPattern")}
                  </button>
                </div>
              </div>
            </section>

            <section className="settings-section">
              <h3>{t("settings.player")}</h3>
              <div className="settings-number-grid">
                <div>
                  <label className="field">
                    <span>{t("settings.skipInterval")}</span>
                    <WholeNumberInput
                      value={draft.skipIntervalSec}
                      {...numberFieldProps("skipIntervalSec")}
                      onValue={(value) => onChange({ ...draft, skipIntervalSec: value })}
                    />
                  </label>
                  <p className="field-hint">{t("settings.skipIntervalHint")}</p>
                </div>
                <div>
                  <label className="field">
                    <span>{t("settings.previewDuration")}</span>
                    <WholeNumberInput
                      value={draft.previewSnippetSeconds}
                      {...numberFieldProps("previewSnippetSeconds")}
                      onValue={(value) => onChange({ ...draft, previewSnippetSeconds: value })}
                    />
                  </label>
                  <p className="field-hint">{t("settings.previewDurationHint")}</p>
                </div>
              </div>
            </section>
          </div>

          <div className="app-tabpanel" {...settingsTablist.getPanelProps("ai")} hidden={activeTab !== "ai"}>
            {/* The tab already says AI, so the sections carry only their own
                names — no heading that repeats the tab label. */}
            <section className="settings-section">
              <h3>{t("settings.gemini")}</h3>
              <p className="field-hint">{t("settings.geminiHint")}</p>
              <div className="field-stack">
                <label className="field">
                  <span>{t("settings.endpoint")}</span>
                  <input spellCheck={false} value={draft.geminiEndpoint} onChange={(event) => onChange({ ...draft, geminiEndpoint: event.target.value })} />
                </label>
                <p className="field-hint">{t("settings.endpointHint")}</p>
                {draft.hasGeminiApiKey ? (
                  <div className="api-key-status">
                    <span className="api-key-status__label">{t("settings.apiKeyConfigured")}</span>
                    <button
                      type="button"
                      className="button button--ghost button--compact"
                      onClick={() => onClearApiKey()}
                      disabled={isSavingApiKey}
                    >
                      {t("settings.removeKey")}
                    </button>
                  </div>
                ) : null}
                <label className="field">
                  <span>{draft.hasGeminiApiKey ? t("settings.replaceKey") : t("settings.apiKey")}</span>
                  <div className="inline-action-field">
                    <input
                      type="password"
                      value={apiKeyInput}
                      placeholder={draft.hasGeminiApiKey ? t("settings.replaceKeyPlaceholder") : t("settings.apiKeyPlaceholder")}
                      onChange={(event) => setApiKeyInput(event.target.value)}
                    />
                    <button
                      type="button"
                      className="button button--ghost"
                      onClick={() => onSetApiKey(apiKeyInput)}
                      disabled={isSavingApiKey || apiKeyInput.trim().length === 0}
                    >
                      {isSavingApiKey ? t("common.saving") : t("settings.saveKey")}
                    </button>
                  </div>
                </label>
                <p className="field-hint">
                  {i18n.rich("settings.apiKeyHint", { variable: <code>GEMINI_API_KEY</code> })}
                </p>
                <ModelField
                  label={t("options.transcriptionModel")}
                  hint={t("settings.transcriptionModelHint")}
                  value={draft.transcriptionModel}
                  thinking={draft.transcriptionThinking}
                  onChange={(transcriptionModel, transcriptionThinking) => onChange({ ...draft, transcriptionModel, transcriptionThinking })}
                />
                <ModelField
                  label={t("options.structuredTranscriptionModel")}
                  hint={t("settings.structuredTranscriptionModelHint")}
                  value={draft.outlineModel}
                  thinking={draft.outlineThinking}
                  onChange={(outlineModel, outlineThinking) => onChange({ ...draft, outlineModel, outlineThinking })}
                />
                <ModelField
                  label={t("options.metadataModel")}
                  hint={t("settings.metadataModelHint")}
                  value={draft.metadataModel}
                  thinking={draft.metadataThinking}
                  onChange={(metadataModel, metadataThinking) => onChange({ ...draft, metadataModel, metadataThinking })}
                />
              </div>
            </section>

            <section className="settings-section">
              <h3>{t("settings.concurrency")}</h3>
              <div className="field-stack">
                <label className="field">
                  <span>{t("settings.concurrentTranscriptions")}</span>
                  <WholeNumberInput
                    value={draft.concurrencyLimit}
                    {...numberFieldProps("concurrencyLimit")}
                    onValue={(value) => onChange({ ...draft, concurrencyLimit: value })}
                  />
                </label>
                <p className="field-hint">{t("settings.concurrentTranscriptionsHint")}</p>
              </div>
            </section>
          </div>

          <div className="app-tabpanel" {...settingsTablist.getPanelProps("prompts")} hidden={activeTab !== "prompts"}>
            <section className="settings-section">
              <div className="field-stack">
                <label className="field">
                  <span>{t("settings.structuredPrompt")}</span>
                  <textarea
                    rows={6}
                    value={draft.structuredPrompt}
                    onChange={(event) => onChange({ ...draft, structuredPrompt: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span>{t("settings.titlePrompt")}</span>
                  <textarea
                    rows={5}
                    value={draft.titlePrompt}
                    onChange={(event) => onChange({ ...draft, titlePrompt: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span>{t("settings.slugPrompt")}</span>
                  <textarea
                    rows={4}
                    value={draft.slugPrompt}
                    onChange={(event) => onChange({ ...draft, slugPrompt: event.target.value })}
                  />
                </label>
                <div>
                  <button
                    type="button"
                    className="button button--danger"
                    onClick={onRestoreDefaultPrompts}
                    disabled={isSaving}
                  >
                    {t("settings.resetPrompts")}
                  </button>
                </div>
              </div>
            </section>
          </div>

        </div>

      </div>
    </ModalShell>
  );
}
