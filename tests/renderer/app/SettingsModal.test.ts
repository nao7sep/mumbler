// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsModal, systemLanguageLabel } from "@renderer/app/SettingsModal";
import { message } from "@shared/i18n/translate";
import { loadCatalogue } from "@shared/i18n/catalogues";
import { createRendererTranslator } from "@renderer/i18n/I18nContext";
import type { MumblerShellApi, SettingsDraft } from "@shared/app-shell";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const openExternal = vi.fn<MumblerShellApi["openExternal"]>();
const reportRendererDiagnostic = vi.fn<MumblerShellApi["reportRendererDiagnostic"]>();

beforeEach(() => {
  openExternal.mockReset();
  openExternal.mockResolvedValue();
  reportRendererDiagnostic.mockReset();
  reportRendererDiagnostic.mockResolvedValue();
  Object.defineProperty(window, "mumbler", {
    configurable: true,
    value: { openExternal, reportRendererDiagnostic } satisfies Partial<MumblerShellApi>,
  });
});

function draft(): SettingsDraft {
  return {
    language: "system",
    theme: "system",
    uiFontFamily: "",
    outputDirectory: "",
    defaultOutputDirectory: "/out",
    backupDirectory: "",
    defaultBackupDirectory: "/backup",
    defaultTimezone: "Asia/Tokyo",
    displayTimezone: "system",
    timestampPatterns: ["(?<year>\\d{4})"],
    skipIntervalSec: 0,
    previewSnippetSeconds: 10,
    hasGeminiApiKey: false,
    geminiEndpoint: "https://generativelanguage.googleapis.com",
    outlineModel: "gemini-3.8-flash",
    transcriptionModel: "gemini-3.7-flash",
    metadataModel: "gemini-3.7-flash",
    transcriptionThinking: "medium",
    outlineThinking: "medium",
    metadataThinking: "minimal",
    concurrencyLimit: 1,
    structuredPrompt: "Prompt",
    titlePrompt: "Prompt",
    slugPrompt: "Prompt",
    retryMaxRetries: 3,
    retryInitialDelayMs: 500,
    retryMaxDelayMs: 5000,
    retryJitterRatio: 0.2,
    transcriptionTimeoutMs: 60000,
    metadataTimeoutMs: 30000,
  };
}

afterEach(async () => {
  if (root !== null) {
    await act(async () => root?.unmount());
    root = null;
  }
  document.body.innerHTML = "";
});

describe("SettingsModal results", () => {
  it("announces save failures and associates numeric validation with its field", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(React.createElement(SettingsModal, {
        draft: draft(),
        isDirty: true,
        isSaving: false,
        isSavingApiKey: false,
        isPickingOutputDirectory: false,
        isPickingBackupDirectory: false,
        errorMessage: message("error.settingsSave"),
        onChange: vi.fn(),
        onClose: vi.fn(),
        onPickOutputDirectory: vi.fn(),
        onPickBackupDirectory: vi.fn(),
        onSetApiKey: vi.fn(),
        onClearApiKey: vi.fn(),
        onRestoreDefaultPrompts: vi.fn(),
        onSave: vi.fn(),
      }));
    });

    const alerts = Array.from(document.querySelectorAll<HTMLElement>('[role="alert"]'));
    expect(alerts.some((alert) => alert.textContent?.includes("Settings could not be saved.")))
      .toBe(true);
    const skipInput = document.querySelector<HTMLInputElement>('input[value="0"]');
    expect(skipInput?.getAttribute("aria-invalid")).toBe("true");
    const descriptionId = skipInput?.getAttribute("aria-describedby");
    expect(descriptionId).toBe("settings-number-error-skipIntervalSec");
    expect(document.getElementById(descriptionId ?? "")?.textContent)
      .toBe("Skip interval must be a positive integer.");
  });

});

describe("SettingsModal theme", () => {
  it("offers System, Light, and Dark as one radio group and edits only the draft", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const onChange = vi.fn();

    await act(async () => {
      root?.render(React.createElement(SettingsModal, {
        draft: draft(),
        isDirty: false,
        isSaving: false,
        isSavingApiKey: false,
        isPickingOutputDirectory: false,
        isPickingBackupDirectory: false,
        errorMessage: null,
        onChange,
        onClose: vi.fn(),
        onPickOutputDirectory: vi.fn(),
        onPickBackupDirectory: vi.fn(),
        onSetApiKey: vi.fn(),
        onClearApiKey: vi.fn(),
        onRestoreDefaultPrompts: vi.fn(),
        onSave: vi.fn(),
      }));
    });

    const radios = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"][name="theme"]'));
    expect(radios.map((radio) => radio.value)).toEqual(["system", "light", "dark"]);
    expect(radios.find((radio) => radio.checked)?.value).toBe("system");
    expect(radios[0]?.closest("fieldset")?.querySelector("legend")?.textContent).toBe("Theme");

    await act(async () => radios[2]?.click());
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ theme: "dark" }));
  });
});

describe("SettingsModal language and time zone", () => {
  async function renderWith(
    onChange: (next: SettingsDraft) => void,
    overrides: Partial<SettingsDraft> = {},
    resolved: { systemLanguage?: "ja"; systemTheme?: "dark" } = {},
  ) {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(React.createElement(SettingsModal, {
        draft: { ...draft(), ...overrides },
        isDirty: false,
        isSaving: false,
        isSavingApiKey: false,
        isPickingOutputDirectory: false,
        isPickingBackupDirectory: false,
        errorMessage: null,
        onChange,
        onClose: vi.fn(),
        onPickOutputDirectory: vi.fn(),
        onPickBackupDirectory: vi.fn(),
        onSetApiKey: vi.fn(),
        onClearApiKey: vi.fn(),
        onRestoreDefaultPrompts: vi.fn(),
        onSave: vi.fn(),
        ...resolved,
      }));
    });
  }

  it("lists System, then each language by its own name, and edits only the draft", async () => {
    const onChange = vi.fn();
    await renderWith(onChange);
    const select = document.querySelector<HTMLSelectElement>('select[aria-labelledby="settings-language-heading"]')!;
    const options = Array.from(select.options);
    expect(options.map((option) => option.value)).toEqual(["system", "en", "de", "es", "fr", "it", "pt-BR", "ru", "ja", "ko", "zh-Hans"]);
    expect(options[8]?.textContent).toBe("日本語");
    expect(options[8]?.lang).toBe("ja");
    expect(select.value).toBe("system");

    await act(async () => {
      select.value = "ja";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ language: "ja" }));
  });

  // timestamp-conventions and app-chrome-conventions: every System entry
  // leads its list and shows what it resolves to now.
  it("offers the zones as a list, with no outside reference to look them up in", async () => {
    await renderWith(vi.fn());
    expect(document.querySelector('a[href*="wikipedia"]')).toBeNull();
    expect(document.body.textContent).not.toContain("Wikipedia");
  });

  it("lists System first in both zone lists, naming the computer's zone", async () => {
    await renderWith(vi.fn(), { defaultTimezone: "Asia/Tokyo", displayTimezone: "system" });
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const selects = Array.from(document.querySelectorAll<HTMLSelectElement>("select"))
      .filter((candidate) => Array.from(candidate.options).some((option) => option.value === "UTC"));
    expect(selects).toHaveLength(2);
    for (const select of selects) {
      expect(select.options[0]?.value).toBe("system");
      expect(select.options[0]?.textContent).toBe(`System (${zone})`);
    }
    expect(selects.map((select) => select.value)).toEqual(["system", "Asia/Tokyo"]);
  });

  it("names the language and theme System resolves to, in the interface language", async () => {
    await renderWith(vi.fn(), {}, { systemLanguage: "ja", systemTheme: "dark" });
    const select = document.querySelector<HTMLSelectElement>('select[aria-labelledby="settings-language-heading"]')!;
    expect(select.options[0]?.textContent).toBe("System (Japanese)");
    expect(document.body.textContent).toContain("System (Dark)");
  });

  // localization-conventions, Translation: both the word and the value are in
  // the interface language.
  it("names the system language in each interface language", async () => {
    await loadCatalogue("ja");
    await loadCatalogue("de");
    expect(systemLanguageLabel(createRendererTranslator("ja"), "ja")).toBe("システム（日本語）");
    expect(systemLanguageLabel(createRendererTranslator("de"), "en")).toBe("System (Englisch)");
    expect(systemLanguageLabel(createRendererTranslator("en"), "zh-Hans")).toBe("System (Simplified Chinese)");
  });
});

describe("SettingsModal folders", () => {
  it("lists the Recordings folder, where imports go, before the output folder", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(React.createElement(SettingsModal, {
        draft: draft(), isDirty: false, isSaving: false, isSavingApiKey: false,
        isPickingOutputDirectory: false, isPickingBackupDirectory: false, errorMessage: null,
        onChange: vi.fn(), onClose: vi.fn(), onPickOutputDirectory: vi.fn(), onPickBackupDirectory: vi.fn(),
        onSetApiKey: vi.fn(), onClearApiKey: vi.fn(), onRestoreDefaultPrompts: vi.fn(), onSave: vi.fn(),
      }));
    });
    const labels = Array.from(document.querySelectorAll(".field > span")).map((label) => label.textContent);
    expect(labels.indexOf("Recordings Directory")).toBeGreaterThanOrEqual(0);
    expect(labels.indexOf("Recordings Directory")).toBeLessThan(labels.indexOf("Output Directory"));
  });
});

describe("SettingsModal AI tab", () => {
  // The modal is held the way the app holds it: each change becomes the next draft.
  function HeldSettings({ initial, onChange }: { initial: SettingsDraft; onChange: (draft: SettingsDraft) => void }) {
    const [held, setHeld] = React.useState(initial);
    return React.createElement(SettingsModal, {
      draft: held,
      isDirty: false,
      isSaving: false,
      isSavingApiKey: false,
      isPickingOutputDirectory: false,
      isPickingBackupDirectory: false,
      errorMessage: null,
      onChange: (next) => { setHeld(next); onChange(next); },
      onClose: vi.fn(),
      onPickOutputDirectory: vi.fn(),
      onPickBackupDirectory: vi.fn(),
      onSetApiKey: vi.fn(),
      onClearApiKey: vi.fn(),
      onRestoreDefaultPrompts: vi.fn(),
      onSave: vi.fn(),
    });
  }

  async function renderAiTab(value: SettingsDraft, onChange = vi.fn(), held = false): Promise<HTMLElement> {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(held ? React.createElement(HeldSettings, { initial: value, onChange }) : React.createElement(SettingsModal, {
        draft: value,
        isDirty: false,
        isSaving: false,
        isSavingApiKey: false,
        isPickingOutputDirectory: false,
        isPickingBackupDirectory: false,
        errorMessage: null,
        onChange,
        onClose: vi.fn(),
        onPickOutputDirectory: vi.fn(),
        onPickBackupDirectory: vi.fn(),
        onSetApiKey: vi.fn(),
        onClearApiKey: vi.fn(),
        onRestoreDefaultPrompts: vi.fn(),
        onSave: vi.fn(),
      }));
    });
    const tab = Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]')).find((node) => node.textContent === "AI");
    await act(async () => tab?.click());
    return Array.from(document.querySelectorAll<HTMLElement>('[role="tabpanel"]')).find((panel) => !panel.hidden)!;
  }

  it("lays out the Gemini section in order, then Concurrency", async () => {
    const panel = await renderAiTab(draft());
    const labels = Array.from(panel.querySelectorAll("h3, label.field > span")).map((node) => node.textContent);
    expect(labels).toEqual([
      "Gemini", "Endpoint URL", "Gemini API Key", "Transcription Model",
      "Structured Transcription Model", "Thinking", "Metadata Model", "Concurrency", "Concurrent Transcriptions",
    ]);
    expect(panel.querySelectorAll("select")).toHaveLength(1);
  });

  it("offers a Thinking field only for a model with a row, listing the row's values", async () => {
    const panel = await renderAiTab({ ...draft(), transcriptionModel: "custom-model", outlineModel: "gemini-3.8-flash", metadataModel: " GEMINI-3.5-FLASH-LITE " });
    const selects = Array.from(panel.querySelectorAll("select"));
    expect(selects.map((select) => Array.from(select.options).map((option) => option.value))).toEqual([
      ["low", "medium", "high"],
      ["minimal", "low", "medium", "high"],
    ]);
    expect(selects.map((select) => select.value)).toEqual(["medium", "minimal"]);
  });

  it.each([
    ["gemini-3.1-pro-preview", ["low", "medium", "high"], "medium"],
    ["gemini-3.8-flash", ["low", "medium", "high"], "medium"],
    ["gemini-3.5-flash-lite", ["minimal", "low", "medium", "high"], "minimal"],
  ])("offers %s on the transcription role with its own Thinking list, in order, at its default", async (model, options, thinking) => {
    const panel = await renderAiTab({ ...draft(), transcriptionModel: model, transcriptionThinking: thinking, outlineModel: "custom-model" });
    const selects = Array.from(panel.querySelectorAll("select"));
    expect(selects.map((select) => [Array.from(select.options).map((option) => option.value), select.value])).toEqual([[options, thinking]]);
  });

  it("resets a role's thinking to the new model's own default when the model changes", async () => {
    const onChange = vi.fn();
    const panel = await renderAiTab({ ...draft(), outlineModel: "gemini-3.8-flash", outlineThinking: "high", metadataModel: "gemini-3.5-flash-lite", metadataThinking: "high" }, onChange);
    const inputFor = (name: string) => Array.from(panel.querySelectorAll<HTMLLabelElement>("label.field"))
      .find((label) => label.querySelector("span")?.textContent === name)!
      .querySelector("input")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    const type = async (name: string, value: string) => act(async () => {
      const input = inputFor(name);
      setValue.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // A smart model on the fast role starts at medium, the smart tier's default.
    await type("Metadata Model", "gemini-3.1-pro-preview");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ metadataModel: "gemini-3.1-pro-preview", metadataThinking: "medium" }));
    // A fast model on the balanced role starts at minimal, the fast tier's default.
    await type("Structured Transcription Model", "gemini-3.5-flash-lite");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ outlineModel: "gemini-3.5-flash-lite", outlineThinking: "minimal" }));
  });

  it("keeps a role's chosen thinking while the model field still resolves to the same row", async () => {
    const onChange = vi.fn();
    const panel = await renderAiTab({ ...draft(), transcriptionModel: "gemini-3.8-flash", transcriptionThinking: "high", outlineModel: "gemini-3.8-flash", outlineThinking: "low", metadataModel: "custom-model", metadataThinking: "high" }, onChange);
    const type = async (name: string, value: string) => act(async () => {
      const input = Array.from(panel.querySelectorAll<HTMLLabelElement>("label.field"))
        .find((label) => label.querySelector("span")?.textContent === name)!
        .querySelector("input")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await type("Transcription Model", "gemini-3.8-flash ");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ transcriptionModel: "gemini-3.8-flash ", transcriptionThinking: "high" }));
    await type("Structured Transcription Model", "GEMINI-3.8-FLASH");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ outlineModel: "GEMINI-3.8-FLASH", outlineThinking: "low" }));
    // A field that opened on an unlisted id keeps the stored value at the first row it reaches that lists it.
    await type("Metadata Model", "gemini-3.5-flash-lite");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ metadataModel: "gemini-3.5-flash-lite", metadataThinking: "high" }));
  });

  describe("reopened on a thinking stored under an unlisted id", () => {
    async function typeMetadataModel(panel: HTMLElement, value: string): Promise<void> {
      const input = Array.from(panel.querySelectorAll<HTMLLabelElement>("label.field"))
        .find((label) => label.querySelector("span")?.textContent === "Metadata Model")!
        .querySelector("input")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }

    it("keeps the stored value on reaching a listed row that offers it, then resets on reaching a different one", async () => {
      const onChange = vi.fn();
      const panel = await renderAiTab({ ...draft(), metadataModel: "custom-model", metadataThinking: "high" }, onChange, true);
      expect(panel.querySelectorAll("select")).toHaveLength(1);
      await typeMetadataModel(panel, "gemini-3.8-flash");
      expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ metadataModel: "gemini-3.8-flash", metadataThinking: "high" }));
      await typeMetadataModel(panel, "gemini-3.5-flash-lite");
      expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ metadataModel: "gemini-3.5-flash-lite", metadataThinking: "minimal" }));
    });

    it("takes the reached row's default when that row does not offer the stored value", async () => {
      const onChange = vi.fn();
      const panel = await renderAiTab({ ...draft(), metadataModel: "custom-model", metadataThinking: "minimal" }, onChange, true);
      await typeMetadataModel(panel, "gemini-3.8-flash");
      expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ metadataModel: "gemini-3.8-flash", metadataThinking: "medium" }));
    });
  });

  it("keeps a role's chosen thinking when a letter of its id is deleted and retyped", async () => {
    const onChange = vi.fn();
    const panel = await renderAiTab({ ...draft(), outlineModel: "gemini-3.8-flash", outlineThinking: "high" }, onChange, true);
    const input = Array.from(panel.querySelectorAll<HTMLLabelElement>("label.field"))
      .find((label) => label.querySelector("span")?.textContent === "Structured Transcription Model")!
      .querySelector("input")!;
    const type = async (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await type("gemini-3.8-flas");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ outlineModel: "gemini-3.8-flas", outlineThinking: "high" }));
    await type("gemini-3.8-flash");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ outlineModel: "gemini-3.8-flash", outlineThinking: "high" }));
    await type("gemini-3.5-flash-lit");
    await type("gemini-3.5-flash-lite");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ outlineModel: "gemini-3.5-flash-lite", outlineThinking: "minimal" }));
  });

  it("warns under a model field whose id has no supported row", async () => {
    const panel = await renderAiTab({ ...draft(), transcriptionModel: " GEMINI-3.8-FLASH ", outlineModel: "gemini-3.8-flash", metadataModel: "custom-model" });
    const warnings = Array.from(panel.querySelectorAll(".field-hint--warning")).map((node) => node.textContent);
    expect(warnings).toEqual(["Not a supported model. It may not work as expected."]);
  });
});

describe("SettingsModal timestamp patterns", () => {
  async function renderPatterns(timestampPatterns: string[], onChange = vi.fn()) {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(React.createElement(SettingsModal, {
        draft: { ...draft(), timestampPatterns }, isDirty: true, isSaving: false, isSavingApiKey: false,
        isPickingOutputDirectory: false, isPickingBackupDirectory: false, errorMessage: null,
        onChange, onClose: vi.fn(), onPickOutputDirectory: vi.fn(), onPickBackupDirectory: vi.fn(),
        onSetApiKey: vi.fn(), onClearApiKey: vi.fn(), onRestoreDefaultPrompts: vi.fn(), onSave: vi.fn(),
      }));
    });
    return onChange;
  }
  const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  const changed = (onChange: ReturnType<typeof vi.fn>) => (onChange.mock.calls.at(-1)![0] as SettingsDraft).timestampPatterns;

  it("shows one row per pattern, in order", async () => {
    await renderPatterns(["a", "b", "c"]);
    const rows = Array.from(document.querySelectorAll<HTMLInputElement>(".pattern-row__input"));
    expect(rows.map((row) => [row.value, row.getAttribute("aria-label")])).toEqual([["a", "Pattern 1"], ["b", "Pattern 2"], ["c", "Pattern 3"]]);
    expect(button("Move pattern 1 up").disabled, "the first row has nowhere up to go").toBe(true);
    expect(button("Move pattern 3 down").disabled, "the last row has nowhere down to go").toBe(true);
  });

  it("moves, removes and adds rows in the draft", async () => {
    const onChange = await renderPatterns(["a", "b", "c"]);
    await act(async () => button("Move pattern 2 up").click());
    expect(changed(onChange)).toEqual(["b", "a", "c"]);
    await act(async () => button("Move pattern 2 down").click());
    expect(changed(onChange)).toEqual(["a", "c", "b"]);
    await act(async () => button("Remove pattern 2").click());
    expect(changed(onChange)).toEqual(["a", "c"]);
    const add = Array.from(document.querySelectorAll("button")).find((element) => element.textContent === "Add pattern")!;
    await act(async () => add.click());
    expect(changed(onChange)).toEqual(["a", "b", "c", ""]);
  });

  it("marks a row that does not compile and holds Save until it does", async () => {
    await renderPatterns(["(?<year>\\d{4})", "("]);
    const rows = document.querySelectorAll<HTMLInputElement>(".pattern-row__input");
    expect(rows[0]!.getAttribute("aria-invalid")).toBeNull();
    expect(rows[1]!.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(rows[1]!.getAttribute("aria-describedby")!)?.textContent)
      .toBe("Timestamp pattern 2 is not a valid regular expression.");
    const save = Array.from(document.querySelectorAll("button")).find((element) => element.textContent === "Save")!;
    expect(save.disabled).toBe(true);
  });
});
