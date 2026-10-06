/// <reference path="../../../src/renderer/src/vite-env.d.ts" />
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppPaths, AppSnapshot, MumblerShellApi } from "@shared/app-shell";
import { App } from "@renderer/app/App";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const hostile = new Error(
  "Error invoking remote method: EACCES /private/tmp/MUMBLER_STARTUP_SENTINEL",
);
const getSnapshot = vi.fn<MumblerShellApi["getSnapshot"]>();
const reportRendererDiagnostic = vi.fn<MumblerShellApi["reportRendererDiagnostic"]>();
let root: Root | null = null;

class TestResizeObserver {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  getSnapshot.mockReset();
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
  it("keeps the ordinary shell unmounted and presents authored recovery for a hostile rejection", async () => {
    getSnapshot.mockRejectedValue(hostile);

    await act(async () => root?.render(createElement(App)));
    await vi.waitFor(() => expect(button("Retry")).toBeDefined());

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
    getSnapshot.mockRejectedValueOnce(hostile).mockResolvedValueOnce(readySnapshot());

    await act(async () => root?.render(createElement(App)));
    await vi.waitFor(() => expect(button("Retry")).toBeDefined());
    await act(async () => button("Retry")!.click());
    await vi.waitFor(() => expect(document.querySelector(".app-shell")).not.toBeNull());

    expect(getSnapshot).toHaveBeenCalledTimes(2);
    expect(document.querySelector(".renderer-failure")).toBeNull();
    expect(document.body.textContent).toContain("Empty queue");
  });
});

describe("a startup diagnostic", () => {
  it("names a store from a newer version and offers no reset", async () => {
    getSnapshot.mockResolvedValue({
      ...readySnapshot(),
      startupDiagnostic: {
        title: { key: "diagnostic.newerTitle" },
        message: { key: "diagnostic.newerBody", values: { path: "/home/me/.mumbler/queue.json" } },
        canReset: false,
      },
    });

    await act(async () => root?.render(createElement(App)));
    await vi.waitFor(() => expect(document.body.textContent).toContain("Saved Data Is From a Newer Version"));

    expect(document.body.textContent).toContain("/home/me/.mumbler/queue.json was saved by a newer version of Mumbler");
    expect(button("Reset State")).toBeUndefined();
  });

  it("names an unreadable work file and offers no reset", async () => {
    getSnapshot.mockResolvedValue({
      ...readySnapshot(),
      startupDiagnostic: {
        title: { key: "diagnostic.corruptTitle" },
        message: { key: "diagnostic.corruptBody", values: { path: "/home/me/.mumbler/queue.json" } },
        canReset: false,
      },
    });

    await act(async () => root?.render(createElement(App)));
    await vi.waitFor(() => expect(document.body.textContent).toContain("Saved Data Could Not Be Loaded"));

    expect(document.body.textContent).toContain("Mumbler could not safely load /home/me/.mumbler/queue.json.");
    expect(button("Reset State")).toBeUndefined();
  });

  it("offers a reset when startup could not finish", async () => {
    getSnapshot.mockResolvedValue({
      ...readySnapshot(),
      startupDiagnostic: {
        title: { key: "diagnostic.startupTitle" },
        message: { key: "diagnostic.startupBody" },
        canReset: true,
      },
    });

    await act(async () => root?.render(createElement(App)));
    await vi.waitFor(() => expect(document.body.textContent).toContain("Startup Failed"));

    expect(button("Reset State")).toBeDefined();
  });

  it("says where a reset set the previous queue and recordings aside, and keeps saying it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      getSnapshot.mockResolvedValue({
        ...readySnapshot(),
        startupDiagnostic: { title: { key: "diagnostic.startupTitle" }, message: { key: "diagnostic.startupBody" }, canReset: true },
      });
      window.mumbler.resetState = vi.fn(async () => ({
        ...readySnapshot(),
        paths: { homeDir: "/home/me/.mumbler" } as AppPaths,
      }));

      await act(async () => root?.render(createElement(App)));
      await vi.waitFor(() => expect(button("Reset State")).toBeDefined());
      await act(async () => button("Reset State")!.click());
      await act(async () => vi.advanceTimersByTime(10_000));

      expect(document.body.textContent).toContain(
        "The previous queue and its recordings were set aside in /home/me/.mumbler,",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a reset that failed part-way where the Reset button is, naming what it moved, and no success notice", async () => {
    getSnapshot.mockResolvedValue({
      ...readySnapshot(),
      startupDiagnostic: { title: { key: "diagnostic.startupTitle" }, message: { key: "diagnostic.startupBody" }, canReset: true },
    });
    window.mumbler.resetState = vi.fn(async (): Promise<AppSnapshot> => ({
      ...readySnapshot(),
      paths: { homeDir: "/home/me/.mumbler" } as AppPaths,
      startupDiagnostic: {
        title: { key: "diagnostic.resetTitle" },
        message: { key: "diagnostic.resetMovedBody", values: { items: ["config.json", "queue.json"], folder: "/home/me/.mumbler" } },
        canReset: true,
      },
    }));

    await act(async () => root?.render(createElement(App)));
    await vi.waitFor(() => expect(button("Reset State")).toBeDefined());
    await act(async () => button("Reset State")!.click());

    const text = document.body.textContent ?? "";
    expect(text).toContain("Reset Failed");
    expect(text).toContain("it set these aside in /home/me/.mumbler, under names that include the time of the reset: config.json, queue.json.");
    expect(text).not.toContain("Reset to defaults.");
    expect(text).not.toContain("unchanged");
    expect(button("Reset State"), "the reset can be tried again").toBeDefined();
  });
});

function rendererApi(): MumblerShellApi {
  const unsubscribe = (): void => undefined;
  return new Proxy(
    {
      getInterfaceLanguage: async () => ({ language: "en", locale: "en-US" }),
      getSnapshot,
      reportRendererDiagnostic,
      onAppWideErrorChanged: () => unsubscribe,
      onDependenciesUpdated: () => unsubscribe,
      onPipelineProgressUpdated: () => unsubscribe,
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
    appName: "Mumbler",
    appVersion: "test",
    platform: "darwin",
    isPackaged: false,
    shellReadyAtUtc: 0,
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
