/// <reference path="../../../src/renderer/src/vite-env.d.ts" />
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSnapshot, MumblerShellApi } from "@shared/app-shell";
import { FirstRunSetupModal } from "@renderer/app/FirstRunSetupModal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
const setGeminiApiKey = vi.fn();
const saveSetupDirectory = vi.fn();
const saveSetupRecordingsDirectory = vi.fn();
const saveSetupTimezone = vi.fn();
const chooseOriginalsDirectory = vi.fn();
const pickOutputDirectory = vi.fn();
const dismissFirstRunSetup = vi.fn();
const close = vi.fn();
const update = vi.fn();
const snapshot = { settingsSummary: {
  outputDirectory: null, defaultOutputDirectory: "/fixtures/Documents/Mumbler",
  backupDirectory: null, defaultBackupDirectory: "/fixtures/Documents/Recordings",
  defaultTimezone: "Asia/Tokyo", hasGeminiApiKey: false,
} } as unknown as AppSnapshot;
function buttons(label: string): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].filter((item) => item.textContent === label);
}
function button(label: string): HTMLButtonElement {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label)!;
}
async function click(label: string): Promise<void> { await act(async () => button(label).click()); }
beforeEach(async () => {
  vi.resetAllMocks();
  dismissFirstRunSetup.mockResolvedValue(undefined);
  Object.defineProperty(window, "mumbler", { configurable: true, value: {
    setGeminiApiKey, saveSetupDirectory, saveSetupRecordingsDirectory, saveSetupTimezone, chooseOriginalsDirectory,
    pickOutputDirectory, dismissFirstRunSetup,
    reportRendererDiagnostic: vi.fn().mockResolvedValue(undefined),
    onUnsavedDrafts: () => () => undefined,
  } satisfies Partial<MumblerShellApi> });
  const container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(FirstRunSetupModal, {
    snapshot, onSnapshot: update, onClose: close,
    tools: { dependencies: [], checkUpdatesAtLaunch: true, isChecking: false, checkNotice: null, operationError: null, onProvision: vi.fn(), onCancelProvision: vi.fn(), onCheck: vi.fn(), onCancelCheck: vi.fn(), onToggleCheckUpdates: vi.fn() },
  })));
});
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ""; });

describe("ordered skippable setup", () => {
  it("visits tools, key, folders and time zone without saving skipped choices", async () => {
    expect(document.body.textContent).toContain("Set Up Mumbler (1/4)");
    await click("Skip");
    expect(document.body.textContent).toContain("Set Up Mumbler (2/4)");
    await click("Skip");
    expect(document.body.textContent).toContain("/fixtures/Documents/Mumbler");
    expect(document.body.textContent, "Recordings sits beside the output folder").toContain("/fixtures/Documents/Recordings");
    await click("Skip");
    expect(document.body.textContent).toContain("Set Up Mumbler (4/4)");
    expect(document.querySelector("select")?.value, "the computer's zone is where the choice starts").toBe("Asia/Tokyo");
    expect([...document.querySelectorAll("option")].map((option) => option.value)).not.toContain("system");
    await click("Skip");
    expect(close).toHaveBeenCalledOnce();
    expect(dismissFirstRunSetup).toHaveBeenCalledOnce();
    expect(setGeminiApiKey).not.toHaveBeenCalled();
    expect(saveSetupDirectory).not.toHaveBeenCalled();
    expect(saveSetupRecordingsDirectory).not.toHaveBeenCalled();
    expect(saveSetupTimezone).not.toHaveBeenCalled();
  });
  it("retains a failed key draft and asks before discarding it", async () => {
    await click("Skip");
    const input = document.querySelector<HTMLInputElement>('input[type="password"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "test-secret");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    setGeminiApiKey.mockRejectedValueOnce(new Error("write refused"));
    await click("Continue");
    expect(input.value).toBe("test-secret");
    expect(document.body.textContent).toContain("The Gemini API key could not be saved");
    await click("Skip");
    expect(document.body.textContent).toContain("You have unsaved changes");
    await click("Keep editing");
    expect(input.value).toBe("test-secret");
    setGeminiApiKey.mockResolvedValueOnce(snapshot);
    await click("Continue");
    expect(document.body.textContent).toContain("Set Up Mumbler (3/4)");
    expect(update).toHaveBeenCalledWith(snapshot);
  });
  it("keeps a cancelled picker on the folder step, then saves both suggested folders", async () => {
    await click("Skip"); await click("Skip");
    pickOutputDirectory.mockResolvedValueOnce(null);
    await act(async () => buttons("Choose Another Folder")[0]!.click());
    expect(saveSetupDirectory).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Set Up Mumbler (3/4)");
    saveSetupDirectory.mockResolvedValueOnce(snapshot);
    saveSetupRecordingsDirectory.mockResolvedValueOnce(snapshot);
    await click("Use These Folders");
    expect(saveSetupDirectory).toHaveBeenCalledWith("/fixtures/Documents/Mumbler");
    expect(saveSetupRecordingsDirectory).toHaveBeenCalledWith("/fixtures/Documents/Recordings");
    expect(document.body.textContent).toContain("Set Up Mumbler (4/4)");
    expect(close).not.toHaveBeenCalled();
  });

  it("saves the Recordings folder as soon as it is picked, and the confirmed time zone at the end", async () => {
    await click("Skip"); await click("Skip");
    chooseOriginalsDirectory.mockResolvedValueOnce(snapshot);
    await act(async () => buttons("Choose Another Folder")[1]!.click());
    expect(chooseOriginalsDirectory).toHaveBeenCalledOnce();
    await click("Skip");
    const select = document.querySelector("select")!;
    await act(async () => {
      select.value = "Europe/Berlin";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    saveSetupTimezone.mockResolvedValueOnce(snapshot);
    await click("Use This Time Zone");
    expect(saveSetupTimezone).toHaveBeenCalledWith("Europe/Berlin");
    expect(close).toHaveBeenCalledOnce();
  });
});
