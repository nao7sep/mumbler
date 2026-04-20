import { useMemo, useState, type ReactElement } from "react";

import type { CommandDefinition, SettingsDraft } from "@shared/app-shell";

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
}: {
  entries: string[];
  onChange: (entries: string[]) => void;
  placeholder: string;
}): ReactElement {
  const [newValue, setNewValue] = useState("");

  function handleAdd(): void {
    const trimmed = newValue.trim();
    if (trimmed.length === 0 || entries.includes(trimmed)) {
      return;
    }
    onChange([...entries, trimmed]);
    setNewValue("");
  }

  function handleRemove(index: number): void {
    onChange(entries.filter((_, i) => i !== index));
  }

  return (
    <div className="editable-list">
      <div className="editable-list__items">
        {entries.map((entry, index) => (
          <div key={`${entry}-${index}`} className="editable-list__item">
            <span>{entry}</span>
            <button
              type="button"
              className="button button--ghost button--compact"
              onClick={() => handleRemove(index)}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <div className="editable-list__add">
        <input
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
  timezones,
  commands,
  isSaving,
  isPickingOutputDirectory,
  errorMessage,
  onChange,
  onClose,
  onPickOutputDirectory,
  onSave,
}: {
  draft: SettingsDraft;
  timezones: string[];
  commands: CommandDefinition[];
  isSaving: boolean;
  isPickingOutputDirectory: boolean;
  errorMessage: string | null;
  onChange: (draft: SettingsDraft) => void;
  onClose: () => void;
  onPickOutputDirectory: () => void;
  onSave: () => void;
}): ReactElement {
  const languageEntries = useMemo(() => parseEntries(draft.languagesText), [draft.languagesText]);
  const patternEntries = useMemo(() => parseEntries(draft.timestampPatternsText), [draft.timestampPatternsText]);

  return (
    <div className="modal-backdrop">
      <section className="modal-card modal-card--settings">
        <div className="modal-card__header">
          <h2>Configuration</h2>
          <button type="button" className="button button--ghost button--compact modal-close" onClick={onClose} disabled={isSaving}>
            ✕
          </button>
        </div>

        {errorMessage ? <p className="inline-error">{errorMessage}</p> : null}

        <div className="settings-sections">
          <section className="settings-section">
            <h3>Credentials</h3>
            <div className="field-stack">
              <label className="field">
                <span>Gemini API Key</span>
                <input
                  type="password"
                  value={draft.geminiApiKeyInput}
                  placeholder={
                    draft.hasGeminiApiKey
                      ? "Leave blank to keep saved key"
                      : "Enter Gemini API key"
                  }
                  onChange={(event) =>
                    onChange({ ...draft, geminiApiKeyInput: event.target.value })
                  }
                />
              </label>
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={draft.clearGeminiApiKey}
                  onChange={(event) =>
                    onChange({ ...draft, clearGeminiApiKey: event.target.checked })
                  }
                />
                <span>Clear saved key</span>
              </label>
            </div>
          </section>

          <section className="settings-section">
            <h3>Output</h3>
            <div className="field-stack">
              <label className="field">
                <span>Output Directory</span>
                <div className="inline-action-field">
                  <input
                    value={draft.outputDirectory}
                    placeholder="/path/to/output"
                    onChange={(event) =>
                      onChange({ ...draft, outputDirectory: event.target.value })
                    }
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
            </div>
          </section>

          <section className="settings-section">
            <h3>Models</h3>
            <div className="field-stack">
              <label className="field">
                <span>Transcription Model</span>
                <input
                  value={draft.transcriptionModel}
                  onChange={(event) =>
                    onChange({ ...draft, transcriptionModel: event.target.value })
                  }
                />
              </label>
              <label className="field">
                <span>Metadata Model</span>
                <input
                  value={draft.metadataModel}
                  onChange={(event) =>
                    onChange({ ...draft, metadataModel: event.target.value })
                  }
                />
              </label>
            </div>
          </section>

          <section className="settings-section">
            <h3>Languages</h3>
            <div className="field-stack">
              <label className="field">
                <span>Default Language</span>
                <input
                  list="settings-language-options"
                  value={draft.defaultLanguage}
                  onChange={(event) =>
                    onChange({ ...draft, defaultLanguage: event.target.value })
                  }
                />
              </label>
              <div className="field">
                <span>Available Languages</span>
                <EditableList
                  entries={languageEntries}
                  onChange={(entries) => onChange({ ...draft, languagesText: entriesToText(entries) })}
                  placeholder="Add language..."
                />
              </div>
            </div>
          </section>

          <section className="settings-section">
            <h3>Timezone</h3>
            <div className="field-stack">
              <label className="field">
                <span>Default Timezone</span>
                <input
                  list="settings-timezone-options"
                  value={draft.defaultTimezone}
                  onChange={(event) =>
                    onChange({ ...draft, defaultTimezone: event.target.value })
                  }
                />
              </label>
              <p className="field-hint">
                Use IANA timezone names (e.g. America/New_York, Asia/Tokyo).
                See <a href="https://en.wikipedia.org/wiki/List_of_tz_database_time_zones" target="_blank" rel="noopener noreferrer">full list on Wikipedia</a>.
              </p>
            </div>
          </section>

          <section className="settings-section">
            <h3>Timestamp Patterns</h3>
            <div className="field-stack">
              <div className="field">
                <span>Regex patterns for parsing timestamps from filenames</span>
                <EditableList
                  entries={patternEntries}
                  onChange={(entries) => onChange({ ...draft, timestampPatternsText: entriesToText(entries) })}
                  placeholder="Add regex pattern..."
                />
              </div>
            </div>
          </section>

          <section className="settings-section">
            <h3>Prompts</h3>
            <div className="field-stack">
              <label className="field">
                <span>Title Prompt</span>
                <textarea
                  rows={4}
                  value={draft.titlePrompt}
                  onChange={(event) =>
                    onChange({ ...draft, titlePrompt: event.target.value })
                  }
                />
              </label>
              <label className="field">
                <span>Slug Prompt</span>
                <textarea
                  rows={3}
                  value={draft.slugPrompt}
                  onChange={(event) =>
                    onChange({ ...draft, slugPrompt: event.target.value })
                  }
                />
              </label>
            </div>
          </section>

          <section className="settings-section">
            <h3>Pipeline</h3>
            <div className="settings-number-grid">
              <label className="field">
                <span>Preview Seconds</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={draft.previewSnippetSeconds}
                  onChange={(event) =>
                    onChange({ ...draft, previewSnippetSeconds: Number.parseInt(event.target.value, 10) })
                  }
                />
              </label>
              <label className="field">
                <span>Concurrency</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={draft.concurrencyLimit}
                  onChange={(event) =>
                    onChange({ ...draft, concurrencyLimit: Number.parseInt(event.target.value, 10) })
                  }
                />
              </label>
              <label className="field">
                <span>Max Retries</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={draft.retryMaxRetries}
                  onChange={(event) =>
                    onChange({ ...draft, retryMaxRetries: Number.parseInt(event.target.value, 10) })
                  }
                />
              </label>
              <label className="field">
                <span>Initial Delay (ms)</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={draft.retryInitialDelayMs}
                  onChange={(event) =>
                    onChange({ ...draft, retryInitialDelayMs: Number.parseInt(event.target.value, 10) })
                  }
                />
              </label>
              <label className="field">
                <span>Max Delay (ms)</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={draft.retryMaxDelayMs}
                  onChange={(event) =>
                    onChange({ ...draft, retryMaxDelayMs: Number.parseInt(event.target.value, 10) })
                  }
                />
              </label>
              <label className="field">
                <span>Jitter Ratio</span>
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={draft.retryJitterRatio}
                  onChange={(event) =>
                    onChange({ ...draft, retryJitterRatio: Number.parseFloat(event.target.value) })
                  }
                />
              </label>
              <label className="field">
                <span>Transcription Timeout (ms)</span>
                <input
                  type="number"
                  min={1}
                  step={1000}
                  value={draft.transcriptionTimeoutMs}
                  onChange={(event) =>
                    onChange({ ...draft, transcriptionTimeoutMs: Number.parseInt(event.target.value, 10) })
                  }
                />
              </label>
              <label className="field">
                <span>Title Timeout (ms)</span>
                <input
                  type="number"
                  min={1}
                  step={1000}
                  value={draft.titleTimeoutMs}
                  onChange={(event) =>
                    onChange({ ...draft, titleTimeoutMs: Number.parseInt(event.target.value, 10) })
                  }
                />
              </label>
              <label className="field">
                <span>Slug Timeout (ms)</span>
                <input
                  type="number"
                  min={1}
                  step={1000}
                  value={draft.slugTimeoutMs}
                  onChange={(event) =>
                    onChange({ ...draft, slugTimeoutMs: Number.parseInt(event.target.value, 10) })
                  }
                />
              </label>
            </div>
          </section>

          <section className="settings-section">
            <h3>Keyboard Shortcuts</h3>
            <div className="shortcut-list">
              {commands.map((command) => (
                <div key={command.id} className="shortcut-item">
                  <span>{command.label}</span>
                  <kbd>{draft.shortcuts[command.id]}</kbd>
                </div>
              ))}
            </div>
          </section>
        </div>

        <div className="modal-actions">
          <button type="button" className="button button--ghost" onClick={onClose} disabled={isSaving}>
            Cancel
          </button>
          <button type="button" className="button button--primary" onClick={onSave} disabled={isSaving}>
            {isSaving ? "Saving..." : "Save"}
          </button>
        </div>

        <datalist id="settings-timezone-options">
          {timezones.map((timezone) => (
            <option key={timezone} value={timezone} />
          ))}
        </datalist>

        <datalist id="settings-language-options">
          {languageEntries.map((language) => (
            <option key={language} value={language} />
          ))}
        </datalist>
      </section>
    </div>
  );
}
