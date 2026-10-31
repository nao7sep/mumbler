/// <reference path="../../../src/renderer/src/vite-env.d.ts" />
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppSnapshot, MumblerShellApi } from "@shared/app-shell";
import { App } from "@renderer/app/App";
import { createDefaultSettings, summarizeSettings } from "@main/core/settings-schema";
import { until } from "../../support/until";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const hostile = new Error(
  "Error invoking remote method: EACCES /private/tmp/MUMBLER_STARTUP_SENTINEL",
);
// What main sends as the subscription's first snapshot.
const firstSnapshot = vi.fn<() => Promise<AppSnapshot>>();
const reportRendererDiagnostic = vi.fn<MumblerShellApi["reportRendererDiagnostic"]>();
let root: Root | null = null;

class TestResizeObserver {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  firstSnapshot.mockReset();
  reportRendererDiagnostic.mockReset();
  reportRendererDiagnostic.mockResolvedValue(undefined);
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  Object.defineProperty(window, "mumbler", {
    configurable: true,
    value: rendererApi(),
  });
  root = createRoot(document.querySelector("#root")!);
});

afterEach(async () => {
  if (root !== null) {
    await act(async () => root?.unmount());
    root = null;
  }
  document.body.innerHTML = "";
  delete (window as unknown as { mumbler?: unknown }).mumbler;
  vi.unstubAllGlobals();
});

describe("App startup snapshot gate", () => {
  it("does not reopen dismissed setup when a new Mac window mounts in the same app session", async () => {
    let firstRun = true;
    firstSnapshot.mockImplementation(async () => ({
      ...readySnapshot(), firstRun, dependencies: [],
      settingsSummary: summarizeSettings(createDefaultSettings(), "/fixtures/Documents/Mumbler", "/fixtures/Documents/Recordings", false),
    }));
    window.mumbler.dismissFirstRunSetup = vi.fn(async () => { firstRun = false; });
    await act(async () => root?.render(createElement(App)));
    await until(() => expect(document.body.textContent).toContain("Set Up Mumbler (1/4)"));
    for (let step = 0; step < 4; step += 1) {
      await act(async () => button("Skip")!.click());
    }
    expect(window.mumbler.dismissFirstRunSetup).toHaveBeenCalledOnce();
    await act(async () => root?.unmount());
    root = createRoot(document.querySelector("#root")!);
    await act(async () => root?.render(createElement(App)));
    await until(() => expect(document.querySelector(".app-shell")).not.toBeNull());
    expect(document.body.textContent).not.toContain("Set Up Mumbler");
  });

  it("keeps the ordinary shell unmounted and presents authored recovery for a hostile rejection", async () => {
    firstSnapshot.mockRejectedValue(hostile);

    await act(async () => root?.render(createElement(App)));
    await until(() => expect(button("Retry")).toBeDefined());

    expect(document.querySelector(".app-shell")).toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Mumbler could not load the current queue",
    );
    expect(document.body.textContent).not.toMatch(
      /EACCES|private\/tmp|MUMBLER_STARTUP_SENTINEL|invoking remote method/i,
    );
    expect(reportRendererDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("MUMBLER_STARTUP_SENTINEL"),
        source: "app snapshot load failed",
      }),
    );
  });

  it("loads the real shell after a successful retry", async () => {
    firstSnapshot.mockRejectedValueOnce(hostile).mockResolvedValueOnce(readySnapshot());

    await act(async () => root?.render(createElement(App)));
    await until(() => expect(button("Retry")).toBeDefined());
    await act(async () => button("Retry")!.click());
    await until(() => expect(document.querySelector(".app-shell")).not.toBeNull());

    expect(firstSnapshot).toHaveBeenCalledTimes(2);
    expect(document.querySelector(".renderer-failure")).toBeNull();
    expect(document.body.textContent).toContain("Empty queue");
  });
});

describe("a startup diagnostic", () => {
  it("names every refused file, newer and unreadable apart, with no way to set them aside", async () => {
    firstSnapshot.mockResolvedValue({
      ...readySnapshot(),
      startupDiagnostic: {
        title: { key: "diagnostic.refusedTitle" },
        message: { key: "diagnostic.refusedBothBody", values: { newer: ["/home/me/.mumbler/layout.json"], unreadable: ["/home/me/.mumbler/config.json"] } },
      },
    });

    await act(async () => root?.render(createElement(App)));
    await until(() => expect(document.body.textContent).toContain("Mumbler Could Not Start"));

    const text = document.body.textContent ?? "";
    expect(text).toContain("A newer version of Mumbler saved these files: /home/me/.mumbler/layout.json.");
    expect(text).toContain("Mumbler could not read these: /home/me/.mumbler/config.json.");
    expect(button("Reset State")).toBeUndefined();
  });
});

function rendererApi(): MumblerShellApi {
  const unsubscribe = (): void => undefined;
  return new Proxy(
    {
      getInterfaceLanguage: async () => ({ language: "en", locale: "en-US" }),
      subscribeSnapshot: async (listener: (snapshot: AppSnapshot) => void) => {
        listener(await firstSnapshot());
        return unsubscribe;
      },
      reportRendererDiagnostic,
      onFlushPendingEdits: () => unsubscribe,
      onUnsavedDrafts: () => unsubscribe,
    } as Partial<MumblerShellApi>,
    {
      get(target, property: keyof MumblerShellApi) {
        if (property in target) return target[property];
        return vi.fn(async () => readySnapshot());
      },
    },
  ) as MumblerShellApi;
}

function readySnapshot(): AppSnapshot {
  return {
    interfaceLanguage: { language: "en", locale: "en-US" },
    systemLanguage: "en",
    systemTheme: "light",
    appName: "Mumbler",
    appVersion: "test",
    platform: "darwin",
    isPackaged: false,
    shellReadyAtUtc: 0,
    firstRun: false,
    paths: null,
    settingsSummary: null,
    queueSummary: null,
    commands: [],
    startupDiagnostic: null,
    appWideError: null,
    state: null,
    layout: null,
    dependencies: null,
  };
}

function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === label,
  );
}
