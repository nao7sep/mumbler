// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsModal } from "@renderer/app/SettingsModal";
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
    schemaVersion: 1,
    uiFontFamily: "",
    outputDirectory: "",
    defaultOutputDirectory: "/out",
    backupDirectory: "",
    defaultBackupDirectory: "/backup",
    defaultTimezone: "Asia/Tokyo",
    timestampPatternsText: "",
    skipIntervalSec: 0,
    previewSnippetSeconds: 10,
    hasGeminiApiKey: false,
    geminiModelsText: "gemini-3.7-flash",
    transcriptionModel: "gemini-3.7-flash",
    metadataModel: "gemini-3.7-flash",
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
        errorMessage: "Settings could not be saved.",
        onChange: vi.fn(),
        onClose: vi.fn(),
        onPickOutputDirectory: vi.fn(),
        onPickBackupDirectory: vi.fn(),
        onSetApiKey: vi.fn(),
        onClearApiKey: vi.fn(),
        onRestoreDefaultPrompts: vi.fn(),
        onRestoreDefaultModels: vi.fn(),
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
        onRestoreDefaultModels: vi.fn(),
        onSave: vi.fn(),
      }));
    });

    const link = document.querySelector<HTMLAnchorElement>('a[href*="time_zones"]');
    await act(async () => link?.click());
    expect(document.body.textContent).toContain("The timezone reference could not be opened. Try again.");
    expect(document.body.textContent).not.toContain("EACCES");
    expect(reportRendererDiagnostic).toHaveBeenCalledOnce();

    openExternal.mockResolvedValueOnce();
    await act(async () => link?.click());
    expect(document.body.textContent).not.toContain("The timezone reference could not be opened. Try again.");
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
        onRestoreDefaultModels: vi.fn(),
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

    expect(document.body.textContent).not.toContain("timezone reference could not be opened");
    expect(document.body.textContent).not.toContain("STALE-TIMEZONE");
    expect(reportRendererDiagnostic).toHaveBeenCalledOnce();
  });
});
