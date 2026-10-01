// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsModal } from "@renderer/app/useSettingsModal";
import { buildSettingsDraft, createDefaultSettings } from "@main/core/settings-schema";
import type { MumblerShellApi } from "@shared/app-shell";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let state: ReturnType<typeof useSettingsModal>;
const saveSettingsDraft = vi.fn<MumblerShellApi["saveSettingsDraft"]>();
const initial = () => buildSettingsDraft(createDefaultSettings(), "", "", true);
let opened = initial;
function Harness() { state = useSettingsModal({ onSnapshotUpdate: vi.fn(), onError: vi.fn(), onNotice: vi.fn() }); return null; }
beforeEach(async () => {
  saveSettingsDraft.mockReset();
  saveSettingsDraft.mockResolvedValue({} as Awaited<ReturnType<MumblerShellApi["saveSettingsDraft"]>>);
  opened = initial;
  Object.defineProperty(window, "mumbler", {
    configurable: true,
    value: {
      getSettingsDraft: vi.fn(async () => opened()),
      getDefaultPrompts: vi.fn(async () => createDefaultSettings().prompts),
      saveSettingsDraft,
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
