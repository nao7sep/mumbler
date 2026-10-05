// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsModal } from "@renderer/app/SettingsModal";
import { message } from "@shared/i18n/translate";
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
    timestampPattern: "",
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
  function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  }

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

  it("owns timezone-reference rejection locally without leaking diagnostics", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    openExternal.mockRejectedValueOnce(new Error("EACCES /private/tmp/timezone-browser"));

    await act(async () => {
      root?.render(React.createElement(SettingsModal, {
        draft: draft(),
        isDirty: false,
        isSaving: false,
        isSavingApiKey: false,
        isPickingOutputDirectory: false,
        isPickingBackupDirectory: false,
        errorMessage: null,
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

    const link = document.querySelector<HTMLAnchorElement>('a[href*="time_zones"]');
    await act(async () => link?.click());
    expect(document.body.textContent).toContain("The time zone reference could not be opened. Try again.");
    expect(document.body.textContent).not.toContain("EACCES");
    expect(reportRendererDiagnostic).toHaveBeenCalledOnce();

    openExternal.mockResolvedValueOnce();
    await act(async () => link?.click());
    expect(document.body.textContent).not.toContain("The time zone reference could not be opened. Try again.");
  });

  it("ignores an older timezone-link settlement after a newer success", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(React.createElement(SettingsModal, {
        draft: draft(),
        isDirty: false,
        isSaving: false,
        isSavingApiKey: false,
        isPickingOutputDirectory: false,
        isPickingBackupDirectory: false,
        errorMessage: null,
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

    const first = deferred<void>();
    const second = deferred<void>();
    openExternal.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const link = document.querySelector<HTMLAnchorElement>('a[href*="time_zones"]');
    await act(async () => { link?.click(); link?.click(); });
    await act(async () => second.resolve());
    await act(async () => first.reject(new Error("EACCES /private/tmp/STALE-TIMEZONE")));

    expect(document.body.textContent).not.toContain("time zone reference could not be opened");
    expect(document.body.textContent).not.toContain("STALE-TIMEZONE");
    expect(reportRendererDiagnostic).toHaveBeenCalledOnce();
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
  async function renderWith(onChange: (next: SettingsDraft) => void, overrides: Partial<SettingsDraft> = {}) {
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

  it("starts the zone list with System, naming the computer's zone", async () => {
    await renderWith(vi.fn(), { defaultTimezone: "system" });
    const select = Array.from(document.querySelectorAll<HTMLSelectElement>("select"))
      .find((candidate) => Array.from(candidate.options).some((option) => option.value === "UTC"))!;
    expect(select.options[0]?.value).toBe("system");
    expect(select.options[0]?.textContent).toBe(`System (${Intl.DateTimeFormat().resolvedOptions().timeZone})`);
    expect(select.value).toBe("system");
  });
});

describe("SettingsModal AI tab", () => {
  async function renderAiTab(value: SettingsDraft, onChange = vi.fn()): Promise<HTMLElement> {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(React.createElement(SettingsModal, {
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

  it("warns under a model field whose id has no supported row", async () => {
    const panel = await renderAiTab({ ...draft(), transcriptionModel: " GEMINI-3.8-FLASH ", outlineModel: "gemini-3.8-flash", metadataModel: "custom-model" });
    const warnings = Array.from(panel.querySelectorAll(".field-hint--warning")).map((node) => node.textContent);
    expect(warnings).toEqual(["Not a supported model. It may not work as expected."]);
  });
});
