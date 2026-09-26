import { useMemo, useRef, useState, type ReactElement } from "react";

import { THEME_PREFERENCES, type SettingsDraft } from "@shared/app-shell";
import {
  getSettingsNumberIssues,
  type NumericSettingField,
} from "@shared/settings-validation";
import { SYSTEM_TIMEZONE, getSupportedTimezones, getSystemTimezone } from "@shared/timestamps";
import { CATALOGUES } from "@shared/i18n/catalogues";
import { LANGUAGES, normalizeLanguagePreference } from "@shared/i18n/languages";
import { useI18n } from "../i18n/I18nContext";
import type { MessageKey } from "@shared/i18n/catalogues";
import { message, type Message } from "@shared/i18n/translate";
import { useComposing, isComposingKeyboardEvent } from "./useComposing";
import { ModalShell } from "./modal/ModalShell";
import { useTablist } from "./useTablist";
import { ExternalLinkIcon } from "./Icon";
import { InlineError } from "./InlineResult";
import { presentFailure } from "./presentFailure";

const TIMEZONE_REFERENCE_URL = "https://en.wikipedia.org/wiki/List_of_tz_database_time_zones";

function parseEntries(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
}

function entriesToText(entries: string[]): string {
  return entries.join("\n");
}

function EditableList({
  entries,
  onChange,
  placeholder,
  monospace = false,
}: {
  entries: string[];
  onChange: (entries: string[]) => void;
  placeholder: string;
  monospace?: boolean;
}): ReactElement {
  const { t } = useI18n();
  const [newValue, setNewValue] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const composing = useComposing();

  function handleAdd(): void {
    const trimmed = newValue.trim();
    if (trimmed.length === 0 || entries.includes(trimmed)) {
      return;
    }
    onChange([...entries, trimmed]);
    setNewValue("");
    // Scroll to bottom after React re-renders
    setTimeout(() => {
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
    }, 0);
  }

  function handleRemove(index: number): void {
    onChange(entries.filter((_, i) => i !== index));
  }

  return (
    <div className="editable-list">
      <div className="editable-list__items" ref={listRef}>
        {entries.map((entry, index) => (
          <div key={`${entry}-${index}`} className="editable-list__item">
            <span style={monospace ? { fontFamily: "var(--font-mono)", fontSize: "1.05em" } : undefined}>{entry}</span>
            <button
              type="button"
              className="button button--ghost button--compact"
              onClick={() => handleRemove(index)}
            >
              {t("common.remove")}
            </button>
          </div>
        ))}
      </div>
      <div className="editable-list__add">
        <input
          style={monospace ? { fontFamily: "var(--font-mono)", fontSize: "1.05em" } : undefined}
          value={newValue}
          placeholder={placeholder}
          onChange={(event) => setNewValue(event.target.value)}
          onCompositionStart={composing.handlers.onCompositionStart}
          onCompositionEnd={composing.handlers.onCompositionEnd}
          onKeyDown={(event) => {
            if (isComposingKeyboardEvent(composing.composingRef, event)) return;
            if (event.key === "Enter") {
              event.preventDefault();
              handleAdd();
            }
          }}
        />
        <button
          type="button"
          className="button button--ghost button--compact"
          onClick={handleAdd}
          disabled={newValue.trim().length === 0}
        >
          {t("common.add")}
        </button>
      </div>
    </div>
  );
}

// The Settings tabs: the four small sections share General, and the old AI
// section splits by concern — provider setup (key, models, concurrency), the
// prompt texts, and the retry/timeout pipeline knobs.
const SETTINGS_TABS = ["general", "ai", "prompts", "pipeline"] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number];
const SETTINGS_TAB_LABELS: Record<SettingsTab, MessageKey> = {
  general: "settings.tabGeneral",
  ai: "settings.tabAi",
  prompts: "settings.tabPrompts",
  pipeline: "settings.tabPipeline",
};

export function SettingsModal({
  draft,
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
  onRestoreDefaultModels,
  onSave,
}: {
  draft: SettingsDraft;
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
  onRestoreDefaultModels: () => void;
  onSave: () => void;
}): ReactElement {
  // The API key field is self-contained: its value is committed to the dedicated
  // secrets file the moment "Save key" is pressed, never bundled into the main
  // Settings Save. The raw key is held only in this local state until then.
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [timezoneLinkError, setTimezoneLinkError] = useState<Message | null>(null);
  const timezoneLinkAttempt = useRef(0);
  const settingsTablist = useTablist<SettingsTab>({
    tabs: SETTINGS_TABS,
    selected: activeTab,
    onSelect: setActiveTab,
    idBase: "settings",
  });
  const patternEntries = useMemo(() => parseEntries(draft.timestampPatternsText), [draft.timestampPatternsText]);
  const geminiModelEntries = useMemo(() => parseEntries(draft.geminiModelsText), [draft.geminiModelsText]);
  const timezoneOptions = useMemo(() => getSupportedTimezones(), []);
  const systemTimezone = useMemo(() => getSystemTimezone(), []);
  const i18n = useI18n();
  const { t, text } = i18n;
  const numberIssues = useMemo(() => getSettingsNumberIssues(draft), [draft]);
  const canSave = isDirty && numberIssues.length === 0 && !isSaving;
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

        {numberIssues.length > 0 ? (
          <InlineError>
            <ul className="settings-number-errors">
              {numberIssues.map((issue) => (
                <li id={`settings-number-error-${issue.field}`} key={issue.field}>
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
                <select
                  aria-labelledby="settings-language-heading"
                  value={draft.language}
                  onChange={(event) => onChange({ ...draft, language: normalizeLanguagePreference(event.target.value) })}
                >
                  <option value="system">{t("settings.languageSystem")}</option>
                  {LANGUAGES.map((language) => (
                    <option key={language} value={language} lang={language}>
                      {CATALOGUES[language]["language.name"] as string}
                    </option>
                  ))}
                </select>
                <p className="field-hint">{t("settings.languageHint")}</p>
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
                        <span>{t(labelKey)}</span>
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
                <p className="field-hint">
                  <a
                    href={TIMEZONE_REFERENCE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(event) => {
                      event.preventDefault();
                      const attempt = ++timezoneLinkAttempt.current;
                      void window.mumbler.openExternal(TIMEZONE_REFERENCE_URL)
                        .then(() => {
                          if (timezoneLinkAttempt.current === attempt) setTimezoneLinkError(null);
                        })
                        .catch((error: unknown) => {
                          const failure = presentFailure(
                            error,
                            message("error.timezoneLink"),
                            "settings timezone link failed",
                          );
                          if (timezoneLinkAttempt.current === attempt) setTimezoneLinkError(failure);
                        });
                    }}
                  >{t("settings.timezoneLink")} <ExternalLinkIcon /></a>
                </p>
                {timezoneLinkError ? (
                  <InlineError onDismiss={() => setTimezoneLinkError(null)}>
                    {text(timezoneLinkError)}
                  </InlineError>
                ) : null}
                <div className="field">
                  <span>{t("settings.timestampPatterns")}</span>
                  <p className="field-hint">{i18n.rich("settings.timestampPatternsHint", {
                    year: <code>year</code>,
                    month: <code>month</code>,
                    day: <code>day</code>,
                    hour: <code>hour</code>,
                    minute: <code>minute</code>,
                    second: <code>second</code>,
                  })}</p>
                  <EditableList
                    monospace
                    entries={patternEntries}
                    onChange={(entries) => onChange({ ...draft, timestampPatternsText: entriesToText(entries) })}
                    placeholder={t("settings.addPattern")}
                  />
                </div>
              </div>
            </section>

            <section className="settings-section">
              <h3>{t("settings.player")}</h3>
              <div className="settings-number-grid">
                <div>
                  <label className="field">
                    <span>{t("settings.skipInterval")}</span>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={draft.skipIntervalSec}
                      {...numberFieldProps("skipIntervalSec")}
                      onChange={(e) => onChange({ ...draft, skipIntervalSec: Number.parseInt(e.target.value, 10) })}
                    />
                  </label>
                  <p className="field-hint">{t("settings.skipIntervalHint")}</p>
                </div>
                <div>
                  <label className="field">
                    <span>{t("settings.previewDuration")}</span>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={draft.previewSnippetSeconds}
                      {...numberFieldProps("previewSnippetSeconds")}
                      onChange={(e) => onChange({ ...draft, previewSnippetSeconds: Number.parseInt(e.target.value, 10) })}
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
                      onClick={() => {
                        onSetApiKey(apiKeyInput);
                        setApiKeyInput("");
                      }}
                      disabled={isSavingApiKey || apiKeyInput.trim().length === 0}
                    >
                      {isSavingApiKey ? t("common.saving") : t("settings.saveKey")}
                    </button>
                  </div>
                </label>
                <p className="field-hint">
                  {i18n.rich("settings.apiKeyHint", { variable: <code>GEMINI_API_KEY</code> })}
                </p>
                <div className="field">
                  <span>{t("settings.geminiModels")}</span>
                  <p className="field-hint">{t("settings.geminiModelsHint")}</p>
                  <EditableList
                    monospace
                    entries={geminiModelEntries}
                    onChange={(entries) => onChange({ ...draft, geminiModelsText: entriesToText(entries) })}
                    placeholder={t("settings.addModel", { example: "gemini-3.5-flash" })}
                  />
                </div>
                <div>
                  <button
                    type="button"
                    className="button button--danger"
                    onClick={onRestoreDefaultModels}
                    disabled={isSaving}
                  >
                    {t("settings.resetModels")}
                  </button>
                </div>
                <label className="field">
                  <span>{t("options.transcriptionModel")}</span>
                  <select
                    value={draft.transcriptionModel}
                    onChange={(event) => onChange({ ...draft, transcriptionModel: event.target.value })}
                  >
                    {geminiModelEntries.map((id) => (
                      <option key={id} value={id}>{id}</option>
                    ))}
                    {draft.transcriptionModel && !geminiModelEntries.includes(draft.transcriptionModel) && (
                      <option value={draft.transcriptionModel}>{draft.transcriptionModel}</option>
                    )}
                  </select>
                </label>
                <p className="field-hint">{t("settings.transcriptionModelHint")}</p>
                <label className="field">
                  <span>{t("options.metadataModel")}</span>
                  <select
                    value={draft.metadataModel}
                    onChange={(event) => onChange({ ...draft, metadataModel: event.target.value })}
                  >
                    {geminiModelEntries.map((id) => (
                      <option key={id} value={id}>{id}</option>
                    ))}
                    {draft.metadataModel && !geminiModelEntries.includes(draft.metadataModel) && (
                      <option value={draft.metadataModel}>{draft.metadataModel}</option>
                    )}
                  </select>
                </label>
                <p className="field-hint">{t("settings.metadataModelHint")}</p>
              </div>
            </section>

            <section className="settings-section">
              <h3>{t("settings.concurrency")}</h3>
              <div className="field-stack">
                <label className="field">
                  <span>{t("settings.concurrentTranscriptions")}</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={draft.concurrencyLimit}
                    {...numberFieldProps("concurrencyLimit")}
                    onChange={(e) => onChange({ ...draft, concurrencyLimit: Number.parseInt(e.target.value, 10) })}
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

          <div className="app-tabpanel" {...settingsTablist.getPanelProps("pipeline")} hidden={activeTab !== "pipeline"}>
            <section className="settings-section">
              <div className="settings-number-grid">
                <div>
                  <label className="field">
                    <span>{t("settings.maxRetries")}</span>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={draft.retryMaxRetries}
                      {...numberFieldProps("retryMaxRetries")}
                      onChange={(event) => onChange({ ...draft, retryMaxRetries: Number.parseInt(event.target.value, 10) })}
                    />
                  </label>
                  <p className="field-hint">{t("settings.maxRetriesHint")}</p>
                </div>
                <div>
                  <label className="field">
                    <span>{t("settings.initialRetryDelay")}</span>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={draft.retryInitialDelayMs}
                      {...numberFieldProps("retryInitialDelayMs")}
                      onChange={(event) => onChange({ ...draft, retryInitialDelayMs: Number.parseInt(event.target.value, 10) })}
                    />
                  </label>
                  <p className="field-hint">{t("settings.initialRetryDelayHint")}</p>
                </div>
                <div>
                  <label className="field">
                    <span>{t("settings.maxRetryDelay")}</span>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={draft.retryMaxDelayMs}
                      {...numberFieldProps("retryMaxDelayMs")}
                      onChange={(event) => onChange({ ...draft, retryMaxDelayMs: Number.parseInt(event.target.value, 10) })}
                    />
                  </label>
                  <p className="field-hint">{t("settings.maxRetryDelayHint")}</p>
                </div>
                <div>
                  <label className="field">
                    <span>{t("settings.retryJitter")}</span>
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      value={draft.retryJitterRatio}
                      {...numberFieldProps("retryJitterRatio")}
                      onChange={(event) => onChange({ ...draft, retryJitterRatio: Number.parseFloat(event.target.value) })}
                    />
                  </label>
                  <p className="field-hint">{t("settings.retryJitterHint")}</p>
                </div>
                <div>
                  <label className="field">
                    <span>{t("settings.transcriptionTimeout")}</span>
                    <input
                      type="number"
                      min={1}
                      step={1000}
                      value={draft.transcriptionTimeoutMs}
                      {...numberFieldProps("transcriptionTimeoutMs")}
                      onChange={(event) => onChange({ ...draft, transcriptionTimeoutMs: Number.parseInt(event.target.value, 10) })}
                    />
                  </label>
                  <p className="field-hint">{t("settings.transcriptionTimeoutHint")}</p>
                </div>
                <div>
                  <label className="field">
                    <span>{t("settings.metadataTimeout")}</span>
                    <input
                      type="number"
                      min={1}
                      step={1000}
                      value={draft.metadataTimeoutMs}
                      {...numberFieldProps("metadataTimeoutMs")}
                      onChange={(event) => onChange({ ...draft, metadataTimeoutMs: Number.parseInt(event.target.value, 10) })}
                    />
                  </label>
                  <p className="field-hint">{t("settings.metadataTimeoutHint")}</p>
                </div>
              </div>
            </section>
          </div>

        </div>

      </div>
    </ModalShell>
  );
}
