// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AboutModal } from "@renderer/app/AboutModal";
import type { MumblerShellApi } from "@shared/app-shell";

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

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("AboutModal external results", () => {
  function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  }

  it("retains hostile link failures independently and clears only matching success", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(React.createElement(AboutModal, { version: "0.1.0", onClose: vi.fn() })));

    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>(".about-links a"));
    const hostile = new Error("EACCES /private/tmp/browser-handler");
    openExternal.mockRejectedValueOnce(hostile).mockRejectedValueOnce(hostile);
    await act(async () => { links[0].click(); links[1].click(); });

    expect(document.body.textContent).toContain("GitHub could not be opened. Try again.");
    expect(document.body.textContent).toContain("Report Issue could not be opened. Try again.");
    expect(document.body.textContent).not.toContain("EACCES");
    expect(reportRendererDiagnostic).toHaveBeenCalledTimes(2);

    openExternal.mockResolvedValueOnce();
    await act(async () => links[0].click());
    expect(document.body.textContent).not.toContain("GitHub could not be opened. Try again.");
    expect(document.body.textContent).toContain("Report Issue could not be opened. Try again.");
  });

  it("does not let an older link settlement replace the current attempt", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(React.createElement(AboutModal, { version: "0.1.0", onClose: vi.fn() })));

    const first = deferred<void>();
    const second = deferred<void>();
    openExternal.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const repo = document.querySelector<HTMLAnchorElement>(".about-links a");
    await act(async () => { repo?.click(); repo?.click(); });
    await act(async () => second.resolve());
    await act(async () => first.reject(new Error("EACCES /private/tmp/STALE-ABOUT")));

    expect(document.body.textContent).not.toContain("GitHub could not be opened");
    expect(document.body.textContent).not.toContain("STALE-ABOUT");
    expect(reportRendererDiagnostic).toHaveBeenCalledOnce();
  });
});
