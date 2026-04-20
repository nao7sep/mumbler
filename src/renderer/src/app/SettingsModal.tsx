import { useMemo, type ReactElement } from "react";

import type { CommandDefinition, CommandId, SettingsDraft } from "@shared/app-shell";

function parseEntries(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
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
  const languageOptions = useMemo(() => parseEntries(draft.languagesText), [draft.languagesText]);

  return (
    <div className="modal-backdrop">
      <section className="modal-card modal-card--settings">
        <div className="modal-card__header">
          <div>
            <p className="section-kicker">Settings</p>
            <h2>Mumbler Configuration</h2>
          </div>
          <span className="muted-tag">
            {draft.hasGeminiApiKey && !draft.clearGeminiApiKey
              ? "Gemini key saved"
              : "Gemini key missing"}
          </span>
        </div>

        {errorMessage ? <p className="inline-error">{errorMessage}</p> : null}

        <div className="settings-grid">
          <section className="detail-card detail-card--nested settings-section">
            <div className="detail-card__header">
              <h3>Credentials</h3>
            </div>
            <div className="field-stack">
              <label className="field">
                <span>Gemini API Key</span>
                <input
                  type="password"
                  value={draft.geminiApiKeyInput}
                  placeholder={
                    draft.hasGeminiApiKey
                      ? "Leave blank to keep the saved key"
                      : "Enter Gemini API key"
                  }
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      geminiApiKeyInput: event.target.value,
                    })
                  }
                />
              </label>
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={draft.clearGeminiApiKey}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      clearGeminiApiKey: event.target.checked,
                    })
                  }
                />
                <span>Clear saved Gemini API key</span>
              </label>
            </div>
          </section>

          <section className="detail-card detail-card--nested settings-section">
            <div className="detail-card__header">
              <h3>Output and Models</h3>
            </div>
            <div className="field-stack">
              <label className="field">
                <span>Output Directory</span>
                <div className="inline-action-field">
                  <input
                    value={draft.outputDirectory}
                    placeholder="/Users/nao7sep/output"
                    onChange={(event) =>
                      onChange({
                        ...draft,
                        outputDirectory: event.target.value,
                      })
                    }
                  />
                  <button
                    type="button"
                    className="button button--ghost"
                    onClick={onPickOutputDirectory}
                    disabled={isPickingOutputDirectory}
                  >
                    {isPickingOutputDirectory ? "Choosing..." : "Browse"}
                  </button>
                </div>
              </label>
              <label className="field">
                <span>Transcription Model</span>
                <input
                  value={draft.transcriptionModel}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      transcriptionModel: event.target.value,
                    })
                  }
                />
              </label>
              <label className="field">
                <span>Metadata Model</span>
                <input
                  value={draft.metadataModel}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      metadataModel: event.target.value,
                    })
                  }
                />
              </label>
            </div>
          </section>

          <section className="detail-card detail-card--nested settings-section">
            <div className="detail-card__header">
              <h3>Languages and Timezone</h3>
            </div>
            <div className="field-stack">
              <label className="field">
                <span>Default Language</span>
                <input
                  list="settings-language-options"
                  value={draft.defaultLanguage}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      defaultLanguage: event.target.value,
                    })
                  }
                />
              </label>
              <label className="field">
                <span>Languages List</span>
                <textarea
                  rows={8}
                  value={draft.languagesText}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      languagesText: event.target.value,
                    })
                  }
                />
              </label>
              <label className="field">
                <span>Default Timezone</span>
                <input
                  list="settings-timezone-options"
                  value={draft.defaultTimezone}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      defaultTimezone: event.target.value,
                    })
                  }
                />
              </label>
            </div>
          </section>

          <section className="detail-card detail-card--nested settings-section">
            <div className="detail-card__header">
              <h3>Timestamp Parsing</h3>
            </div>
            <div className="field-stack">
              <label className="field">
                <span>Timestamp Regex Patterns</span>
                <textarea
                  rows={8}
                  value={draft.timestampPatternsText}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      timestampPatternsText: event.target.value,
                    })
                  }
                />
              </label>
            </div>
          </section>

          <section className="detail-card detail-card--nested settings-section settings-section--wide">
            <div className="detail-card__header">
              <h3>Metadata Prompts</h3>
            </div>
            <div className="field-stack">
              <label className="field">
                <span>Title Prompt</span>
                <textarea
                  rows={6}
                  value={draft.titlePrompt}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      titlePrompt: event.target.value,
                    })
                  }
                />
              </label>
              <label className="field">
                <span>Slug Prompt</span>
                <textarea
                  rows={5}
                  value={draft.slugPrompt}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      slugPrompt: event.target.value,
                    })
                  }
                />
              </label>
            </div>
          </section>

          <section className="detail-card detail-card--nested settings-section settings-section--wide">
            <div className="detail-card__header">
              <h3>Playback and Pipeline</h3>
            </div>
            <div className="settings-number-grid">
              <label className="field">
                <span>Preview Snippet Seconds</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={draft.previewSnippetSeconds}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      previewSnippetSeconds: Number.parseInt(event.target.value, 10),
                    })
                  }
                />
              </label>
              <label className="field">
                <span>Concurrency Limit</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={draft.concurrencyLimit}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      concurrencyLimit: Number.parseInt(event.target.value, 10),
                    })
                  }
                />
              </label>
              <label className="field">
                <span>Retry Max Retries</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={draft.retryMaxRetries}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      retryMaxRetries: Number.parseInt(event.target.value, 10),
                    })
                  }
                />
              </label>
              <label className="field">
                <span>Retry Initial Delay Ms</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={draft.retryInitialDelayMs}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      retryInitialDelayMs: Number.parseInt(event.target.value, 10),
                    })
                  }
                />
              </label>
              <label className="field">
                <span>Retry Max Delay Ms</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={draft.retryMaxDelayMs}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      retryMaxDelayMs: Number.parseInt(event.target.value, 10),
                    })
                  }
                />
              </label>
              <label className="field">
                <span>Retry Jitter Ratio</span>
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={draft.retryJitterRatio}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      retryJitterRatio: Number.parseFloat(event.target.value),
                    })
                  }
                />
              </label>
              <label className="field">
                <span>Transcription Timeout Ms</span>
                <input
                  type="number"
                  min={1}
                  step={1000}
                  value={draft.transcriptionTimeoutMs}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      transcriptionTimeoutMs: Number.parseInt(event.target.value, 10),
                    })
                  }
                />
              </label>
              <label className="field">
                <span>Title Timeout Ms</span>
                <input
                  type="number"
                  min={1}
                  step={1000}
                  value={draft.titleTimeoutMs}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      titleTimeoutMs: Number.parseInt(event.target.value, 10),
                    })
                  }
                />
              </label>
              <label className="field">
                <span>Slug Timeout Ms</span>
                <input
                  type="number"
                  min={1}
                  step={1000}
                  value={draft.slugTimeoutMs}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      slugTimeoutMs: Number.parseInt(event.target.value, 10),
                    })
                  }
                />
              </label>
            </div>
          </section>

          <section className="detail-card detail-card--nested settings-section settings-section--wide">
            <div className="detail-card__header">
              <h3>Keyboard Shortcuts</h3>
            </div>
            <div className="shortcut-list">
              {commands.map((command) => (
                <label key={command.id} className="shortcut-item shortcut-item--editable">
                  <span>{command.label}</span>
                  <input
                    value={draft.shortcuts[command.id]}
                    onChange={(event) =>
                      onChange({
                        ...draft,
                        shortcuts: {
                          ...draft.shortcuts,
                          [command.id as CommandId]: event.target.value,
                        },
                      })
                    }
                  />
                </label>
              ))}
            </div>
          </section>
        </div>

        <div className="modal-actions">
          <button type="button" className="button button--ghost" onClick={onClose} disabled={isSaving}>
            Cancel
          </button>
          <button type="button" className="button button--primary" onClick={onSave} disabled={isSaving}>
            {isSaving ? "Saving..." : "Save Settings"}
          </button>
        </div>

        <datalist id="settings-timezone-options">
          {timezones.map((timezone) => (
            <option key={timezone} value={timezone} />
          ))}
        </datalist>

        <datalist id="settings-language-options">
          {languageOptions.map((language) => (
            <option key={language} value={language} />
          ))}
        </datalist>
      </section>
    </div>
  );
}
