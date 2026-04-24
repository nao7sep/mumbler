import { useMemo, useRef, useState, type ReactElement } from "react";

import type { SettingsDraft } from "@shared/app-shell";
import { getSupportedTimezones } from "@shared/timestamps";

const GEMINI_MODELS = [
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
  { id: "gemini-3.1-flash-preview", label: "Gemini 3.1 Flash" },
  { id: "gemini-3.1-flash-lite-preview", label: "Gemini 3.1 Flash Lite" },
];

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
  disabledEntries = [],
}: {
  entries: string[];
  onChange: (entries: string[]) => void;
  placeholder: string;
  monospace?: boolean;
  disabledEntries?: string[];
}): ReactElement {
  const [newValue, setNewValue] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

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
              disabled={disabledEntries.includes(entry)}
              title={disabledEntries.includes(entry) ? "Cannot remove the default language" : undefined}
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
          onKeyDown={(event) => {
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
  isSaving,
  isPickingOutputDirectory,
  errorMessage,
  onChange,
  onClose,
  onPickOutputDirectory,
  onSave,
}: {
  draft: SettingsDraft;
  isSaving: boolean;
  isPickingOutputDirectory: boolean;
  errorMessage: string | null;
  onChange: (draft: SettingsDraft) => void;
  onClose: () => void;
  onPickOutputDirectory: () => void;
  onSave: () => void;
}): ReactElement {
  const patternEntries = useMemo(() => parseEntries(draft.timestampPatternsText), [draft.timestampPatternsText]);
  const timezoneOptions = useMemo(() => getSupportedTimezones(), []);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="modal-card modal-card--settings" onClick={(e) => e.stopPropagation()}>
        <div className="modal-card__header">
          <h2>Settings</h2>
          <button type="button" className="button button--ghost button--compact modal-close" onClick={onClose} disabled={isSaving}>
            ✕
          </button>
        </div>

        <div className="modal-card__body">

          {errorMessage ? <p className="inline-error">{errorMessage}</p> : null}

          <div className="settings-sections">

          <section className="settings-section">
            <h3>Timestamps</h3>
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
            </div>
            <p className="field-hint">Seconds of audio played by the Play First and Play Last buttons.</p>
          </section>

          <section className="settings-section">
            <h3>AI</h3>
            <div className="settings-number-grid">
              <div>
                <label className="field">
                  <span>Concurrent Jobs</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={draft.concurrencyLimit}
                    onChange={(e) => onChange({ ...draft, concurrencyLimit: Number.parseInt(e.target.value, 10) })}
                  />
                </label>
                <p className="field-hint">Maximum number of cards processed simultaneously.</p>
              </div>
            </div>

            <h4 className="settings-subheading">Gemini</h4>
            <p className="field-hint">Gemini is the only supported AI provider at this time.</p>
            <div className="field-stack">
              {draft.hasGeminiApiKey && !draft.clearGeminiApiKey ? (
                <div className="api-key-status">
                  <span className="api-key-status__label">Gemini API key is saved.</span>
                  <button
                    type="button"
                    className="button button--ghost button--compact"
                    onClick={() => onChange({ ...draft, clearGeminiApiKey: true })}
                  >
                    Remove key
                  </button>
                </div>
              ) : draft.clearGeminiApiKey ? (
                <div className="api-key-status api-key-status--removing">
                  <span className="api-key-status__label">Key will be removed on save.</span>
                  <button
                    type="button"
                    className="button button--ghost button--compact"
                    onClick={() => onChange({ ...draft, clearGeminiApiKey: false })}
                  >
                    Keep key
                  </button>
                </div>
              ) : null}
              <label className="field">
                <span>{draft.hasGeminiApiKey && !draft.clearGeminiApiKey ? "Replace key" : "Gemini API Key"}</span>
                <input
                  type="password"
                  value={draft.geminiApiKeyInput}
                  placeholder={draft.hasGeminiApiKey && !draft.clearGeminiApiKey ? "Enter new key to replace" : "Enter Gemini API key"}
                  onChange={(event) => onChange({ ...draft, geminiApiKeyInput: event.target.value })}
                />
              </label>
              <label className="field">
                <span>Transcription Model</span>
                <select
                  value={draft.transcriptionModel}
                  onChange={(event) => onChange({ ...draft, transcriptionModel: event.target.value })}
                >
                  {GEMINI_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                  {!GEMINI_MODELS.some((m) => m.id === draft.transcriptionModel) && (
                    <option value={draft.transcriptionModel}>{draft.transcriptionModel}</option>
                  )}
                </select>
              </label>
              <label className="field">
                <span>Metadata Model</span>
                <select
                  value={draft.metadataModel}
                  onChange={(event) => onChange({ ...draft, metadataModel: event.target.value })}
                >
                  {GEMINI_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                  {!GEMINI_MODELS.some((m) => m.id === draft.metadataModel) && (
                    <option value={draft.metadataModel}>{draft.metadataModel}</option>
                  )}
                </select>
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
                <p className="field-hint">Time allowed per transcription request.</p>
              </div>
              <div>
                <label className="field">
                  <span>Title Generation Timeout (ms)</span>
                  <input
                    type="number"
                    min={1}
                    step={1000}
                    value={draft.titleTimeoutMs}
                    onChange={(event) => onChange({ ...draft, titleTimeoutMs: Number.parseInt(event.target.value, 10) })}
                  />
                </label>
                <p className="field-hint">Time allowed per title generation request.</p>
              </div>
              <div>
                <label className="field">
                  <span>Slug Generation Timeout (ms)</span>
                  <input
                    type="number"
                    min={1}
                    step={1000}
                    value={draft.slugTimeoutMs}
                    onChange={(event) => onChange({ ...draft, slugTimeoutMs: Number.parseInt(event.target.value, 10) })}
                  />
                </label>
                <p className="field-hint">Time allowed per slug generation request.</p>
              </div>
            </div>
          </section>

          <section className="settings-section">
            <h3>Output</h3>
            <div className="field-stack">
              <label className="field">
                <span>Default Directory</span>
                <div className="inline-action-field">
                  <input
                    value={draft.outputDirectory}
                    placeholder="/path/to/output"
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
              <p className="field-hint">Where exported files are saved. Can be changed per recording.</p>
            </div>
          </section>

          </div>

        </div>

        <div className="modal-actions">
          <button type="button" className="button button--primary" onClick={onSave} disabled={isSaving}>
            {isSaving ? "Saving…" : "Save"}
          </button>
        </div>
      </section>
    </div>
  );
}
