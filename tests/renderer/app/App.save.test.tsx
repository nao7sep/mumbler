/// <reference path="../../../src/renderer/src/vite-env.d.ts" />
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "@renderer/app/App";
import type { AppSnapshot, MumblerCard, MumblerShellApi, SaveCardResult } from "@shared/app-shell";
import { createDefaultSettings, summarizeSettings } from "@main/core/settings-schema";
import { createTranslator, message } from "@shared/i18n/translate";
import type { MessageKey } from "@shared/i18n/catalogues";

// Playback is outside this mounted Save flow; the rest of App and its modals
// stay real, with persistence outcomes supplied only at the shell boundary.
vi.mock("@renderer/app/WaveformEditor", () => ({ WaveformEditor: () => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const english = createTranslator("en");
const saveCard = vi.fn<MumblerShellApi["saveCard"]>();
const generateCardStep = vi.fn<MumblerShellApi["generateCardStep"]>();
const removeCard = vi.fn<MumblerShellApi["removeCard"]>();
const reportRendererDiagnostic = vi.fn<MumblerShellApi["reportRendererDiagnostic"]>();
let root: Root | null = null;
let initialSnapshot: AppSnapshot;
let pipelineChanged: (() => void) | undefined;

class TestResizeObserver {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

function readyCard(): MumblerCard {
  const time = Date.UTC(2026, 2, 1, 7, 30);
  return {
    id: "ready-card", originalFilename: "take.wav", importSource: "file-picker",
    sourceFilePath: "/working/take.wav", audioProfile: null, durationSec: 60, fileSizeBytes: 1024,
    timestamps: { confirmedLocal: "2026-03-01 07:30:00", confirmedUtc: time, timezone: "UTC",
      frontTrimOffsetSec: 1, effectiveLocal: "2026-03-01 07:30:01", effectiveUtc: time + 1000 },
    trim: { frontMarkerSec: 1, backMarkerSec: 59 }, trimDecision: null,
    transcribedTrim: { frontMarkerSec: 1, backMarkerSec: 59 },
    transcription: { text: "Preserved transcript" },
    metadata: { structured: "Preserved outline", title: "Preserved title", slug: "preserved-title" },
    ai: { transcription: null, structured: null, title: null, slug: null },
    status: "Ready to Save", activeStep: null, queuedMode: null, queuedAtUtc: null, lastError: null,
    createdAtUtc: time, updatedAtUtc: time,
  };
}

function snapshot(cards: MumblerCard[] = [readyCard()]): AppSnapshot {
  return {
    interfaceLanguage: { language: "en", locale: "en-US" }, systemLanguage: "en", systemTheme: "light",
    appName: "Mumbler", appVersion: "test", platform: "darwin", isPackaged: false,
    shellReadyAtUtc: 0, firstRun: false, paths: null,
    settingsSummary: summarizeSettings({ ...createDefaultSettings(), outputDirectory: "/exports", defaultTimezone: "UTC", displayTimezone: "UTC" }, "/exports", "/originals", true),
    queueSummary: { cardCount: cards.length, pendingImportCount: 0, selectedCardId: cards[0]?.id ?? null, recoveredInterruptedCards: 0 },
    state: { cards, pendingImports: [] },
    layout: { queueWidth: 300, recordsListWidth: 300, selectedCardId: cards[0]?.id ?? null, setupPending: false },
    commands: [], startupDiagnostic: null, appWideError: null, dependencies: [],
  };
}

const outputs = {
  audioPath: "/exports/20260301-073001-preserved-title.wav",
  jsonPath: "/exports/20260301-073001-preserved-title.json",
  markdownPath: "/exports/20260301-073001-preserved-title.md",
};
const conflict = (): SaveCardResult => ({ kind: "conflict", snapshot: initialSnapshot, ...outputs });
const saved = (remove = true): SaveCardResult => ({ kind: "saved", snapshot: remove ? snapshot([]) : initialSnapshot, ...outputs });

function button(key: MessageKey, scope: ParentNode = document): HTMLButtonElement {
  const label = english.text(message(key));
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === label);
  if (!found) throw new Error(`No button labelled ${label}`);
  return found;
}
function selectedCardText(): string[] {
  return [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(".result-output")].map((field) => field.value);
}
function removeAfterSave(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>('.checkbox-field input[type="checkbox"]')!;
}
async function mount(): Promise<void> {
  await act(async () => root?.render(createElement(App)));
  await vi.waitFor(() => expect(document.querySelector(".app-shell")).not.toBeNull());
  await act(async () => button("detail.tabOutput").click());
  expect(button("output.save").disabled).toBe(false);
}
async function clickSave(): Promise<void> {
  await act(async () => button("output.save").click());
}
function deferredSave() {
  let resolve!: (result: SaveCardResult) => void;
  const promise = new Promise<SaveCardResult>((settle) => { resolve = settle; });
  return { promise, resolve };
}

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  initialSnapshot = snapshot();
  pipelineChanged = undefined;
  saveCard.mockReset();
  generateCardStep.mockReset().mockImplementation(async () => initialSnapshot);
  removeCard.mockReset();
  reportRendererDiagnostic.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
  const unsubscribe = (): void => undefined;
  Object.defineProperty(window, "mumbler", { configurable: true, value: {
    getInterfaceLanguage: vi.fn(async () => initialSnapshot.interfaceLanguage),
    getSnapshot: vi.fn(async () => initialSnapshot),
    saveCard, generateCardStep, removeCard, reportRendererDiagnostic,
    onAppWideErrorChanged: () => unsubscribe,
    onDependenciesUpdated: () => unsubscribe,
    onPipelineProgressUpdated: (listener) => { pipelineChanged = listener; return unsubscribe; },
    onFlushPendingEdits: () => unsubscribe,
    onUnsavedDrafts: () => unsubscribe,
  } satisfies Partial<MumblerShellApi> });
  root = createRoot(document.querySelector("#root")!);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  delete (window as unknown as { mumbler?: unknown }).mumbler;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("App saving a recording", () => {
  it("keeps the card, its generated content and the removal choice when a conflict is cancelled", async () => {
    saveCard.mockResolvedValue(conflict());
    await mount();
    const contentBefore = selectedCardText();
    expect(contentBefore).toContain("Preserved transcript");
    await act(async () => removeAfterSave().click());
    expect(removeAfterSave().checked).toBe(false);
    await clickSave();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(outputs.audioPath);
    await act(async () => button("common.cancel", document.querySelector('[role="dialog"]')!).click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(saveCard).toHaveBeenCalledExactlyOnceWith("ready-card", undefined, { removeAfterSave: false });
    expect(selectedCardText()).toEqual(contentBefore);
    expect(removeAfterSave().checked).toBe(false);
    expect(document.querySelector(".detail-pane")?.textContent).toContain("take.wav");
    expect(button("output.save").disabled).toBe(false);
    expect(removeCard).not.toHaveBeenCalled();
  });

  it.each([
    ["decision.overwrite", "overwrite"],
    ["decision.addSuffix", "suffix"],
  ] as const)("resubmits the conflict using %s and renders the successful result", async (choice, strategy) => {
    saveCard.mockResolvedValueOnce(conflict()).mockResolvedValueOnce(saved());
    await mount();
    await clickSave();
    await act(async () => button(choice, document.querySelector('[role="dialog"]')!).click());
    expect(saveCard).toHaveBeenNthCalledWith(2, "ready-card", strategy, { removeAfterSave: true });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector(".queue-empty")?.textContent).toContain("Empty queue");
    expect(document.body.textContent).toContain("Saved");
    expect(removeCard).not.toHaveBeenCalled();
  });

  it("keeps the card and displays authored recovery after a rejected save", async () => {
    saveCard.mockRejectedValue(new Error("Error invoking remote method: EACCES /private/SAVE_SENTINEL"));
    await mount();
    const contentBefore = selectedCardText();
    await clickSave();
    expect(document.querySelector('.card-action-results [role="alert"]')?.textContent)
      .toContain(english.text(message("error.saveRecording")));
    expect(document.body.textContent).not.toMatch(/SAVE_SENTINEL|EACCES|invoking remote method/);
    expect(selectedCardText()).toEqual(contentBefore);
    expect(button("output.save").disabled).toBe(false);
    expect(removeCard).not.toHaveBeenCalled();
  });

  it("shows the completed output names supplied with a partial save failure", async () => {
    const audioName = outputs.audioPath.split("/").at(-1)!;
    const jsonName = outputs.jsonPath.split("/").at(-1)!;
    const detail = message("error.saveIncomplete", { folder: "/exports", files: `${audioName}, ${jsonName}` });
    saveCard.mockResolvedValue({ kind: "failed", snapshot: initialSnapshot, message: detail,
      files: [{ path: outputs.audioPath, status: "saved" }, { path: outputs.jsonPath, status: "saved" }, { path: outputs.markdownPath, status: "failed" }] });
    await mount();
    await clickSave();
    const error = document.querySelector('.card-action-results [role="alert"]')?.textContent;
    expect(error).toContain(english.text(detail));
    expect(error).toContain(audioName);
    expect(error).toContain(jsonName);
    expect(error).not.toContain(outputs.markdownPath.split("/").at(-1)!);
    expect(selectedCardText()).toContain("Preserved transcript");
    expect(button("output.save").disabled).toBe(false);
    expect(removeCard).not.toHaveBeenCalled();
  });

  it("keeps the card while removal-after-save is awaiting the durable save result", async () => {
    const pending = deferredSave();
    saveCard.mockReturnValue(pending.promise);
    await mount();
    expect(removeAfterSave().checked).toBe(true);
    await clickSave();
    expect(saveCard).toHaveBeenCalledExactlyOnceWith("ready-card", undefined, { removeAfterSave: true });
    expect(selectedCardText()).toContain("Preserved transcript");
    expect(document.querySelector(".queue-empty")).toBeNull();
    expect(removeCard).not.toHaveBeenCalled();
    await act(async () => pending.resolve(saved()));
    expect(document.querySelector(".queue-empty")?.textContent).toContain("Empty queue");
    expect(document.querySelector(".result-output")).toBeNull();
    expect(removeCard).not.toHaveBeenCalled();
  });
});

describe("App generation readiness", () => {
  it.each(["key", "endpoint"] as const)("disables individual generation and Retry when the %s is unavailable, including live changes", async (missing) => {
    const card = readyCard();
    card.status = "Error";
    card.lastError = { message: "Previous attempt failed", failedStep: "title", occurredAtUtc: 0 };
    initialSnapshot = snapshot([card]);
    initialSnapshot.settingsSummary![missing === "key" ? "hasGeminiApiKey" : "providerEndpointAllowed"] = false;
    await act(async () => root?.render(createElement(App)));
    await act(async () => button("detail.tabTranscribe").click());
    const generateButtons = () => [...document.querySelectorAll<HTMLButtonElement>("button")]
      .filter((node) => node.textContent === english.text(message("transcribe.generate")));
    expect(generateButtons()).toHaveLength(4);
    expect(generateButtons().every((node) => node.disabled)).toBe(true);
    expect(button("common.retry").disabled).toBe(true);
    if (missing === "endpoint") expect(document.body.textContent).toContain(english.text(message("diagnostic.endpointRequiresHttps")));

    initialSnapshot = { ...initialSnapshot, settingsSummary: { ...initialSnapshot.settingsSummary!, hasGeminiApiKey: true, providerEndpointAllowed: true } };
    await act(async () => pipelineChanged?.());
    expect(generateButtons().every((node) => !node.disabled)).toBe(true);
    expect(button("common.retry").disabled).toBe(false);
    expect(document.body.textContent).not.toContain(english.text(message("diagnostic.endpointRequiresHttps")));

    initialSnapshot = { ...initialSnapshot, settingsSummary: { ...initialSnapshot.settingsSummary!, hasGeminiApiKey: false } };
    await act(async () => pipelineChanged?.());
    expect(generateButtons().every((node) => node.disabled)).toBe(true);
    expect(button("common.retry").disabled).toBe(true);
  });
});
