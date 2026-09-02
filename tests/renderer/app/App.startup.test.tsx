/// <reference path="../../../src/renderer/src/vite-env.d.ts" />
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppSnapshot, MumblerShellApi } from "@shared/app-shell";
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

function rendererApi(): MumblerShellApi {
  const unsubscribe = (): void => undefined;
  return new Proxy(
    {
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
