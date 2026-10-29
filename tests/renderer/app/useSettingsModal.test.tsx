// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsModal } from "@renderer/app/SettingsModal";
import { useSettingsModal } from "@renderer/app/useSettingsModal";
import { applySettingsDraft, buildSettingsDraft, createDefaultSettings } from "@main/core/settings-schema";
import { join, parse } from "node:path";
import type { MumblerShellApi } from "@shared/app-shell";
import { message } from "@shared/i18n/translate";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let state: ReturnType<typeof useSettingsModal>;
const saveSettingsDraft = vi.fn<MumblerShellApi["saveSettingsDraft"]>();
const pickOutputDirectory = vi.fn<MumblerShellApi["pickOutputDirectory"]>();
const pickBackupDirectory = vi.fn<MumblerShellApi["pickBackupDirectory"]>();
const initial = () => buildSettingsDraft(createDefaultSettings(), "", "", true);
let opened = initial;
let unsaved: { report: () => string[]; discard: () => void } | null = null;
const onNotice = vi.fn();
const onLastingNotice = vi.fn();
const setGeminiApiKey = vi.fn<MumblerShellApi["setGeminiApiKey"]>();
const clearGeminiApiKey = vi.fn<MumblerShellApi["clearGeminiApiKey"]>();
function Harness() { state = useSettingsModal({ onError: vi.fn(), onNotice, onLastingNotice }); return null; }
beforeEach(async () => {
  saveSettingsDraft.mockReset();
  pickOutputDirectory.mockReset();
  pickBackupDirectory.mockReset();
  clearGeminiApiKey.mockReset();
  setGeminiApiKey.mockReset();
  onNotice.mockReset();
  onLastingNotice.mockReset();
  saveSettingsDraft.mockResolvedValue(undefined);
  opened = initial;
  Object.defineProperty(window, "mumbler", {
    configurable: true,
    value: {
      getSettingsDraft: vi.fn(async () => opened()),
      getDefaultPrompts: vi.fn(async () => createDefaultSettings().prompts),
      saveSettingsDraft,
      pickOutputDirectory,
      pickBackupDirectory,
      clearGeminiApiKey,
      setGeminiApiKey,
      onUnsavedDrafts: (report, discard) => { unsaved = { report, discard }; return () => { unsaved = null; }; },
    } satisfies Partial<MumblerShellApi>,
  });
  const node = document.createElement("div"); document.body.append(node); root = createRoot(node);
  await act(async () => root?.render(React.createElement(Harness)));
});
afterEach(async () => { if (root) await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

describe("Reset prompts", () => {
  const custom = () => ({ ...initial(), structuredPrompt: "Custom {transcript}", titlePrompt: "Custom {structured}", slugPrompt: "Custom {title}" });

  it("fills the draft with the built-ins, and Save sends them for the built-in comparison", async () => {
    opened = custom;
    await act(async () => state.handleOpenSettings());
    await act(async () => state.handleRestoreDefaultPrompts());
    const { prompts } = createDefaultSettings();
    expect(state.settingsDraft).toMatchObject({ structuredPrompt: prompts.structured, titlePrompt: prompts.title, slugPrompt: prompts.slug });
    expect(saveSettingsDraft).not.toHaveBeenCalled();
    await act(async () => state.handleSaveSettings());
    expect(saveSettingsDraft).toHaveBeenCalledWith({ ...custom(), structuredPrompt: prompts.structured, titlePrompt: prompts.title, slugPrompt: prompts.slug });
  });

  it("is discarded with the other edits when Settings is cancelled", async () => {
    opened = custom;
    await act(async () => state.handleOpenSettings());
    await act(async () => state.handleRestoreDefaultPrompts());
    await act(async () => state.handleRequestCloseSettings());
    await act(async () => state.handleConfirmDiscardSettings());
    expect(state.settingsDraft).toBeNull();
    expect(saveSettingsDraft).not.toHaveBeenCalled();
  });
});

describe("a quit or window close", () => {
  it("reports unsaved Settings changes, and closes Settings without saving when they are discarded", async () => {
    expect(unsaved?.report()).toEqual([]);
    await act(async () => state.handleOpenSettings());
    expect(unsaved?.report()).toEqual([]);
    await act(async () => state.setSettingsDraft((draft) => draft && { ...draft, structuredPrompt: "Edited {transcript}" }));
    expect(unsaved?.report()).toEqual(["settings"]);
    await act(async () => unsaved?.discard());
    expect(state.settingsDraft).toBeNull();
    expect(unsaved?.report()).toEqual([]);
    expect(saveSettingsDraft).not.toHaveBeenCalled();
  });
});

describe("picked Settings directories", () => {
  it.each([
    ["outputDirectory", "literalOutputDirectory", pickOutputDirectory, "handlePickSettingsOutputDirectory"],
    ["backupDirectory", "literalBackupDirectory", pickBackupDirectory, "handlePickSettingsBackupDirectory"],
  ] as const)("uses the unsaved %s for repeated Browse and leaves Cancel unchanged", async (field, literal, picker, action) => {
    await act(async () => state.handleOpenSettings());
    await act(async () => state.setSettingsDraft((draft) => draft && { ...draft, [field]: "~/typed-folder" }));
    const picked = join(parse(process.cwd()).root, "chosen", "$LITERAL");
    picker.mockResolvedValueOnce(picked).mockResolvedValueOnce(null);
    await act(async () => state[action]());
    expect(picker).toHaveBeenNthCalledWith(1, "~/typed-folder", "");
    expect(state.settingsDraft).toMatchObject({ [field]: picked, [literal]: picked });
    const beforeCancel = state.settingsDraft;
    await act(async () => state[action]());
    expect(picker).toHaveBeenNthCalledWith(2, picked, picked);
    expect(state.settingsDraft).toBe(beforeCancel);
    expect(state.isSettingsDirty).toBe(true);
    expect(saveSettingsDraft).not.toHaveBeenCalled();
    expect(field === "outputDirectory" ? pickBackupDirectory : pickOutputDirectory).not.toHaveBeenCalled();
    await act(async () => state.handleRequestCloseSettings());
    expect(state.showDiscardConfirm).toBe(true);
    await act(async () => state.handleConfirmDiscardSettings());
    expect(saveSettingsDraft).not.toHaveBeenCalled();
  });

  it("saves both picker results as literal paths even when their names contain environment syntax", async () => {
    const home = join(parse(process.cwd()).root, "Users", "test");
    const output = join(home, "$MUMBLER_TEST_PICKED", "Exports");
    const originals = join(home, "%MUMBLER_TEST_PICKED%", "Originals");
    vi.stubEnv("MUMBLER_TEST_PICKED", "redirected");
    try {
      await act(async () => state.handleOpenSettings());
      pickOutputDirectory.mockResolvedValueOnce(output);
      pickBackupDirectory.mockResolvedValueOnce(originals);
      await act(async () => state.handlePickSettingsOutputDirectory());
      await act(async () => state.handlePickSettingsBackupDirectory());
      await act(async () => state.handleSaveSettings());
      expect(applySettingsDraft(createDefaultSettings(), saveSettingsDraft.mock.calls[0]![0], home))
        .toMatchObject({ outputDirectory: output, backupDirectory: originals });
    } finally { vi.unstubAllEnvs(); }
  });
});

describe("removing the stored API key", () => {
  const removed = (hasGeminiApiKey: boolean) =>
    ({ hasGeminiApiKey });

  it("confirms a plain removal with a toast", async () => {
    clearGeminiApiKey.mockResolvedValueOnce(removed(false));
    await act(async () => state.handleClearGeminiApiKey());
    expect(onNotice).toHaveBeenCalledWith(message("notice.apiKeyRemoved"));
    expect(onLastingNotice).not.toHaveBeenCalled();
  });

  it("keeps the news that an environment key is still in use until it is closed", async () => {
    clearGeminiApiKey.mockResolvedValueOnce(removed(true));
    await act(async () => state.handleClearGeminiApiKey());
    expect(onLastingNotice).toHaveBeenCalledWith(message("notice.apiKeyRemovedEnvRemains"));
    expect(onNotice).not.toHaveBeenCalled();
  });
});

function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const keySnapshot = (hasGeminiApiKey = true) =>
  ({ hasGeminiApiKey });

describe("Settings draft settlement", () => {
  it("protects an unsaved key on modal close and quit, reporting only the Settings label", async () => {
    await act(async () => state.handleOpenSettings());
    await act(async () => state.setApiKeyInput(" draft secret "));
    expect(state.isSettingsDirty).toBe(true);
    expect(unsaved?.report()).toEqual(["settings"]);
    await act(async () => state.handleRequestCloseSettings());
    expect(state.showDiscardConfirm).toBe(true);
    await act(async () => state.handleCancelDiscardSettings());
    expect(state.apiKeyInput).toBe(" draft secret ");
    await act(async () => unsaved?.discard());
    expect(state.apiKeyInput).toBe("");
    expect(state.settingsDraft).toBeNull();
    expect(unsaved?.report()).toEqual([]);
    expect(setGeminiApiKey).not.toHaveBeenCalled();
  });

  it("retains a failed key draft, then clears the exact submitted draft only on success", async () => {
    setGeminiApiKey.mockRejectedValueOnce(new Error("Save failed")).mockResolvedValueOnce(keySnapshot());
    await act(async () => state.handleOpenSettings());
    await act(async () => state.setApiKeyInput(" submitted key "));
    await act(async () => state.handleSetGeminiApiKey(state.apiKeyInput));
    expect(state.apiKeyInput).toBe(" submitted key ");
    expect(state.settingsErrorMessage).not.toBeNull();
    await act(async () => state.handleSetGeminiApiKey(state.apiKeyInput));
    expect(setGeminiApiKey).toHaveBeenLastCalledWith("submitted key");
    expect(state.apiKeyInput).toBe("");
    expect(state.settingsErrorMessage).toBeNull();
    expect(state.isSettingsDirty).toBe(false);
  });

  it("keeps text typed during a key save and ignores repeated key actions until settlement", async () => {
    const saving = pending<ReturnType<typeof keySnapshot>>();
    setGeminiApiKey.mockReturnValueOnce(saving.promise);
    await act(async () => state.handleOpenSettings());
    await act(async () => state.setApiKeyInput("submitted"));
    let operation!: Promise<void>;
    await act(async () => {
      operation = state.handleSetGeminiApiKey(state.apiKeyInput);
      void state.handleSetGeminiApiKey(state.apiKeyInput);
      void state.handleClearGeminiApiKey();
    });
    await act(async () => state.setApiKeyInput("newer key"));
    await act(async () => { saving.resolve(keySnapshot()); await operation; });
    expect(setGeminiApiKey).toHaveBeenCalledTimes(1);
    expect(clearGeminiApiKey).not.toHaveBeenCalled();
    expect(state.apiKeyInput).toBe("newer key");
    expect(state.settingsDraft?.hasGeminiApiKey).toBe(true);
    expect(state.isSettingsDirty).toBe(true);
  });

  it("keeps a key draft after ordinary Settings Save, without submitting the secret", async () => {
    await act(async () => state.handleOpenSettings());
    await act(async () => state.setApiKeyInput("unsaved secret"));
    const submitted = state.settingsDraft;
    await act(async () => state.handleSaveSettings());
    expect(saveSettingsDraft).toHaveBeenCalledWith(submitted);
    expect(JSON.stringify(saveSettingsDraft.mock.calls)).not.toContain("unsaved secret");
    expect(setGeminiApiKey).not.toHaveBeenCalled();
    expect(state.settingsDraft).toBe(submitted);
    expect(state.apiKeyInput).toBe("unsaved secret");
    expect(state.isSettingsDirty).toBe(true);
    await act(async () => state.setApiKeyInput(""));
    expect(state.isSettingsDirty).toBe(false);
  });

  it("keeps newer Settings edits and compares them against the completed save", async () => {
    const saving = pending<void>();
    saveSettingsDraft.mockReturnValueOnce(saving.promise);
    await act(async () => state.handleOpenSettings());
    await act(async () => state.setSettingsDraft((draft) => draft && { ...draft, titlePrompt: "submitted" }));
    const submitted = state.settingsDraft;
    let operation!: Promise<void>;
    await act(async () => {
      operation = state.handleSaveSettings();
      void state.handleSaveSettings();
    });
    await act(async () => {
      state.setSettingsDraft((draft) => draft && { ...draft, titlePrompt: "newer" });
      saving.resolve();
      await operation;
    });
    expect(saveSettingsDraft).toHaveBeenCalledTimes(1);
    expect(saveSettingsDraft).toHaveBeenCalledWith(submitted);
    expect(state.settingsDraft?.titlePrompt).toBe("newer");
    expect(state.isSettingsDirty).toBe(true);
    await act(async () => state.setSettingsDraft(submitted));
    expect(state.isSettingsDirty).toBe(false);
  });

  it("preserves current key presence in the baseline when Settings finishes after key removal", async () => {
    const saving = pending<void>();
    saveSettingsDraft.mockReturnValueOnce(saving.promise);
    clearGeminiApiKey.mockResolvedValueOnce(keySnapshot(false));
    await act(async () => state.handleOpenSettings());
    await act(async () => state.setSettingsDraft((draft) => draft && { ...draft, titlePrompt: "submitted" }));
    let operation!: Promise<void>;
    await act(async () => { operation = state.handleSaveSettings(); });
    await act(async () => state.handleClearGeminiApiKey());
    await act(async () => state.setSettingsDraft((draft) => draft && { ...draft, titlePrompt: "newer" }));
    await act(async () => { saving.resolve(); await operation; });
    expect(state.settingsDraft?.hasGeminiApiKey).toBe(false);
    await act(async () => state.setSettingsDraft((draft) => draft && { ...draft, titlePrompt: "submitted" }));
    expect(state.isSettingsDirty).toBe(false);
  });

  it("keeps a key first typed while Settings Save was pending", async () => {
    const saving = pending<void>();
    saveSettingsDraft.mockReturnValueOnce(saving.promise);
    await act(async () => state.handleOpenSettings());
    let operation!: Promise<void>;
    await act(async () => { operation = state.handleSaveSettings(); });
    await act(async () => {
      state.setApiKeyInput("new secret");
      saving.resolve();
      await operation;
    });
    expect(state.settingsDraft).not.toBeNull();
    expect(state.apiKeyInput).toBe("new secret");
    expect(setGeminiApiKey).not.toHaveBeenCalled();
    expect(state.isSettingsDirty).toBe(true);
  });

  it("retains settings and secret drafts after a failed Settings Save and allows retry", async () => {
    saveSettingsDraft.mockRejectedValueOnce(new Error("Save failed"));
    await act(async () => state.handleOpenSettings());
    await act(async () => {
      state.setSettingsDraft((draft) => draft && { ...draft, titlePrompt: "edited" });
      state.setApiKeyInput("unsaved key");
    });
    await act(async () => state.handleSaveSettings());
    expect(state.settingsDraft?.titlePrompt).toBe("edited");
    expect(state.apiKeyInput).toBe("unsaved key");
    expect(state.settingsErrorMessage).not.toBeNull();
    expect(state.isSavingSettings).toBe(false);
    expect(state.isSettingsDirty).toBe(true);
    await act(async () => state.handleSaveSettings());
    expect(saveSettingsDraft).toHaveBeenCalledTimes(2);
    expect(state.settingsErrorMessage).toBeNull();
    expect(state.apiKeyInput).toBe("unsaved key");
  });

  it("closes ordinary Settings Save when its submitted revision remains current", async () => {
    await act(async () => state.handleOpenSettings());
    await act(async () => state.setSettingsDraft((draft) => draft && { ...draft, titlePrompt: "submitted" }));
    await act(async () => state.handleSaveSettings());
    expect(state.settingsDraft).toBeNull();
    expect(state.isSettingsDirty).toBe(false);
  });
});

function MountedSettings() {
  const modal = useSettingsModal({ onError: vi.fn(), onNotice, onLastingNotice });
  state = modal;
  return modal.settingsDraft && React.createElement(SettingsModal, {
    draft: modal.settingsDraft,
    apiKeyInput: modal.apiKeyInput,
    setApiKeyInput: modal.setApiKeyInput,
    isDirty: modal.isSettingsDirty,
    isSaving: modal.isSavingSettings,
    isSavingApiKey: modal.isSavingApiKey,
    isPickingOutputDirectory: false,
    isPickingBackupDirectory: false,
    errorMessage: modal.settingsErrorMessage,
    onChange: modal.setSettingsDraft,
    onClose: modal.handleRequestCloseSettings,
    onSetApiKey: modal.handleSetGeminiApiKey,
    onClearApiKey: modal.handleClearGeminiApiKey,
    onPickOutputDirectory: vi.fn(), onPickBackupDirectory: vi.fn(),
    onRestoreDefaultPrompts: modal.handleRestoreDefaultPrompts,
    onSave: modal.handleSaveSettings,
  });
}

describe("mounted Settings key input", () => {
  it("retains failed input and shows newer input after an earlier key save succeeds", async () => {
    setGeminiApiKey.mockRejectedValueOnce(new Error("Save failed"));
    await act(async () => root?.render(React.createElement(MountedSettings)));
    await act(async () => state.handleOpenSettings());
    await act(async () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((tab) => tab.textContent === "AI")!.click());
    const field = () => document.querySelector<HTMLInputElement>('input[type="password"]')!;
    const type = async (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field(), value);
      field().dispatchEvent(new Event("input", { bubbles: true }));
    });
    const saveKey = () => Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Save key")!;
    await type("first key");
    await act(async () => saveKey().click());
    expect(field().value).toBe("first key");
    const saving = pending<ReturnType<typeof keySnapshot>>();
    setGeminiApiKey.mockReturnValueOnce(saving.promise);
    await act(async () => saveKey().click());
    await type("second key");
    await act(async () => saving.resolve(keySnapshot()));
    expect(field().value).toBe("second key");
    expect(unsaved?.report()).toEqual(["settings"]);
  });
});
