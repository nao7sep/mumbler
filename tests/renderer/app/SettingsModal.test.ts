// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsModal } from "@renderer/app/SettingsModal";
import type { SettingsDraft } from "@shared/app-shell";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

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
});
