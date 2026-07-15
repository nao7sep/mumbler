import { useMemo, useRef, useState, type ReactElement } from "react";

import { type SettingsDraft } from "@shared/app-shell";
import { getSettingsNumberErrors } from "@shared/settings-validation";
import { getSupportedTimezones } from "@shared/timestamps";
import { useComposing, isComposingKeyboardEvent } from "./useComposing";
import { ModalShell } from "./modal/ModalShell";

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
            <span style={monospace ? { fontFamily: "monospace", fontSize: "1.05em" } : undefined}>{entry}</span>
            <button
              type="button"
              className="button button--ghost button--compact"
              onClick={() => handleRemove(index)}
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      <div className="editable-list__add">
        <input
          style={monospace ? { fontFamily: "monospace", fontSize: "1.05em" } : undefined}
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
          Add
        </button>
      </div>
    </div>
  );
}

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
  errorMessage: string | null;
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
  const patternEntries = useMemo(() => parseEntries(draft.timestampPatternsText), [draft.timestampPatternsText]);
  const geminiModelEntries = useMemo(() => parseEntries(draft.geminiModelsText), [draft.geminiModelsText]);
  const timezoneOptions = useMemo(() => getSupportedTimezones(), []);
  const numberErrors = useMemo(() => getSettingsNumberErrors(draft), [draft]);
  const canSave = isDirty && numberErrors.length === 0 && !isSaving;

  return (
    <ModalShell
      title="Settings"
      size="settings"
      onRequestClose={onClose}
      closeDisabled={isSaving}
      footer={
        <>
          <button type="button" className="button button--ghost" onClick={onClose} disabled={isSaving}>
            Cancel
          </button>
          <button type="button" className="button button--primary" onClick={onSave} disabled={!canSave}>
            {isSaving ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div className="modal-card__body">

        {errorMessage ? <p className="inline-error">{errorMessage}</p> : null}

        {numberErrors.length > 0 ? (
          <ul className="inline-error settings-number-errors">
            {numberErrors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        ) : null}

        <div className="settings-sections">

          <section className="settings-section">
            <h3>Appearance</h3>
            <div className="field-stack">
              <label className="field">
                <span>UI font</span>
                <input
                  value={draft.uiFontFamily}
                  placeholder="Default"
                  onChange={(event) => onChange({ ...draft, uiFontFamily: event.target.value })}
                />
              </label>
              <p className="field-hint">
                The app interface font. Comma-separated families; the first one your system has is used. Blank uses the built-in default.
              </p>
            </div>
          </section>

          <section className="settings-section">
            <h3>Files</h3>
            <div className="field-stack">
              <label className="field">
                <span>Output Directory</span>
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
                    Browse
                  </button>
                </div>
              </label>
              <p className="field-hint">
                Where exported files are saved. Leave blank to use the default ({draft.defaultOutputDirectory}).
              </p>
              <label className="field">
                <span>Backup Directory</span>
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
                    Browse
                  </button>
                </div>
              </label>
              <p className="field-hint">
                Used when "Copy originals to backup folder" is selected during import. Leave blank to use the default ({draft.defaultBackupDirectory}).
              </p>
            </div>
          </section>

          <section className="settings-section">
            <h3>Import</h3>
            <div className="field-stack">
              <label className="field">
                <span>Default Timezone</span>
                <select
                  value={draft.defaultTimezone}
                  onChange={(event) => onChange({ ...draft, defaultTimezone: event.target.value })}
                >
                  {timezoneOptions.map((tz) => (
                    <option key={tz} value={tz}>{tz}</option>
                  ))}
                </select>
              </label>
              <p className="field-hint">
                <a href="https://en.wikipedia.org/wiki/List_of_tz_database_time_zones" target="_blank" rel="noopener noreferrer">Full timezone list on Wikipedia ↗</a>
              </p>
              <div className="field">
                <span>Timestamp Patterns</span>
                <p className="field-hint">Named groups: <code>year</code> (2 or 4 digits), <code>month</code>, <code>day</code>, <code>hour</code>, <code>minute</code>, <code>second</code> (optional).</p>
                <EditableList
                  monospace
                  entries={patternEntries}
                  onChange={(entries) => onChange({ ...draft, timestampPatternsText: entriesToText(entries) })}
                  placeholder="Add regex pattern..."
                />
              </div>
            </div>
          </section>

          <section className="settings-section">
            <h3>Player</h3>
            <div className="settings-number-grid">
              <div>
                <label className="field">
                  <span>Skip Interval (seconds)</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={draft.skipIntervalSec}
                    onChange={(e) => onChange({ ...draft, skipIntervalSec: Number.parseInt(e.target.value, 10) })}
                  />
                </label>
                <p className="field-hint">Seconds jumped by the Left / Right keys.</p>
              </div>
              <div>
                <label className="field">
                  <span>Preview Duration (seconds)</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={draft.previewSnippetSeconds}
                    onChange={(e) => onChange({ ...draft, previewSnippetSeconds: Number.parseInt(e.target.value, 10) })}
                  />
                </label>
                <p className="field-hint">Seconds played by the Play First/Last buttons.</p>
              </div>
            </div>
          </section>

          <section className="settings-section">
            <h3>AI</h3>

            <h4 className="settings-subheading">Gemini</h4>
            <p className="field-hint">Gemini is the only supported AI provider at this time.</p>
            <div className="field-stack">
              {draft.hasGeminiApiKey ? (
                <div className="api-key-status">
                  <span className="api-key-status__label">A Gemini API key is configured.</span>
                  <button
                    type="button"
                    className="button button--ghost button--compact"
                    onClick={() => onClearApiKey()}
                    disabled={isSavingApiKey}
                  >
                    Remove key
                  </button>
                </div>
              ) : null}
              <label className="field">
                <span>{draft.hasGeminiApiKey ? "Replace key" : "Gemini API Key"}</span>
                <div className="inline-action-field">
                  <input
                    type="password"
                    value={apiKeyInput}
                    placeholder={draft.hasGeminiApiKey ? "Enter new key to replace" : "Enter Gemini API key"}
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
                    {isSavingApiKey ? "Saving…" : "Save key"}
                  </button>
                </div>
              </label>
              <p className="field-hint">
                Stored in its own secured file, not in settings. A <code>GEMINI_API_KEY</code> environment variable, if set, takes precedence over the saved key.
              </p>
              <div className="field">
                <span>Gemini Models</span>
                <p className="field-hint">Your model list — add any Gemini model id here, remove ones you don't use. The two selectors below pick from this list; to use a new model, add it here first. An invalid or retired id is reported when a job runs, not here.</p>
                <EditableList
                  monospace
                  entries={geminiModelEntries}
                  onChange={(entries) => onChange({ ...draft, geminiModelsText: entriesToText(entries) })}
                  placeholder="Add model id, e.g. gemini-3.5-flash"
                />
              </div>
              <div>
                <button
                  type="button"
                  className="button button--danger"
                  onClick={onRestoreDefaultModels}
                  disabled={isSaving}
                >
                  Reset models
                </button>
              </div>
              <label className="field">
                <span>Transcription Model</span>
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
              <p className="field-hint">Used for transcription and structured transcription. Choose a capable model for long audio.</p>
              <label className="field">
                <span>Metadata Model</span>
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
              <p className="field-hint">Used for title and slug generation. A lighter model is fine for short text tasks.</p>
            </div>

            <h4 className="settings-subheading">Concurrency</h4>
            <div className="field-stack">
              <label className="field">
                <span>Concurrent Transcriptions</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={draft.concurrencyLimit}
                  onChange={(e) => onChange({ ...draft, concurrencyLimit: Number.parseInt(e.target.value, 10) })}
                />
              </label>
              <p className="field-hint">Maximum number of audio transcription jobs that can run at once. Each job loads a full audio file into the AI context, so keep this low unless you have a high API quota.</p>
            </div>

            <h4 className="settings-subheading">Prompts</h4>
            <div className="field-stack">
              <label className="field">
                <span>Structured Prompt</span>
                <textarea
                  rows={6}
                  value={draft.structuredPrompt}
                  onChange={(event) => onChange({ ...draft, structuredPrompt: event.target.value })}
                />
              </label>
              <label className="field">
                <span>Title Prompt</span>
                <textarea
                  rows={5}
                  value={draft.titlePrompt}
                  onChange={(event) => onChange({ ...draft, titlePrompt: event.target.value })}
                />
              </label>
              <label className="field">
                <span>Slug Prompt</span>
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
                  Reset prompts
                </button>
              </div>
            </div>

            <h4 className="settings-subheading">Pipeline</h4>
            <div className="settings-number-grid">
              <div>
                <label className="field">
                  <span>Max Retries</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={draft.retryMaxRetries}
                    onChange={(event) => onChange({ ...draft, retryMaxRetries: Number.parseInt(event.target.value, 10) })}
                  />
                </label>
                <p className="field-hint">Maximum number of retry attempts per AI call.</p>
              </div>
              <div>
                <label className="field">
                  <span>Initial Retry Delay (ms)</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={draft.retryInitialDelayMs}
                    onChange={(event) => onChange({ ...draft, retryInitialDelayMs: Number.parseInt(event.target.value, 10) })}
                  />
                </label>
                <p className="field-hint">Wait time before the first retry.</p>
              </div>
              <div>
                <label className="field">
                  <span>Max Retry Delay (ms)</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={draft.retryMaxDelayMs}
                    onChange={(event) => onChange({ ...draft, retryMaxDelayMs: Number.parseInt(event.target.value, 10) })}
                  />
                </label>
                <p className="field-hint">Upper bound on retry wait time.</p>
              </div>
              <div>
                <label className="field">
                  <span>Retry Jitter (0–1)</span>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={draft.retryJitterRatio}
                    onChange={(event) => onChange({ ...draft, retryJitterRatio: Number.parseFloat(event.target.value) })}
                  />
                </label>
                <p className="field-hint">Randomness added to retry delays to avoid thundering herd.</p>
              </div>
              <div>
                <label className="field">
                  <span>Transcription Timeout (ms)</span>
                  <input
                    type="number"
                    min={1}
                    step={1000}
                    value={draft.transcriptionTimeoutMs}
                    onChange={(event) => onChange({ ...draft, transcriptionTimeoutMs: Number.parseInt(event.target.value, 10) })}
                  />
                </label>
                <p className="field-hint">Time allowed per transcription or structured transcription request.</p>
              </div>
              <div>
                <label className="field">
                  <span>Metadata Generation Timeout (ms)</span>
                  <input
                    type="number"
                    min={1}
                    step={1000}
                    value={draft.metadataTimeoutMs}
                    onChange={(event) => onChange({ ...draft, metadataTimeoutMs: Number.parseInt(event.target.value, 10) })}
                  />
                </label>
                <p className="field-hint">Time allowed for each title or slug generation request.</p>
              </div>
            </div>
          </section>

        </div>

      </div>
    </ModalShell>
  );
}
