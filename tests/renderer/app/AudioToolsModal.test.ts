// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AudioToolsModal } from "@renderer/app/AudioToolsModal";
import type { DependencyStatus } from "@shared/app-shell";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

const dependency: DependencyStatus = {
  name: "ffmpeg",
  required: true,
  state: "not-installed",
  role: "warning",
  installedVersion: null,
  desiredVersion: null,
  lastCheckedAtUtc: null,
  transient: { kind: "running", operation: "check", percent: null },
};

afterEach(async () => {
  if (root !== null) {
    await act(async () => root?.unmount());
    root = null;
  }
  document.body.innerHTML = "";
  document.body.style.overflow = "";
});

describe("AudioToolsModal update check", () => {
  it("offers the caller-visible cancel action while a check is running", async () => {
    const onCheck = vi.fn();
    const onCancelCheck = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        React.createElement(AudioToolsModal, {
          dependencies: [dependency],
          checkUpdatesAtLaunch: true,
          isChecking: true,
          checkNotice: null,
          operationError: null,
          onProvision: vi.fn(),
          onCancelProvision: vi.fn(),
          onCheck,
          onCancelCheck,
          onToggleCheckUpdates: vi.fn(),
          onClose: vi.fn(),
        }),
      );
    });

    const cancel = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Cancel check",
    );
    expect(cancel).toBeInstanceOf(HTMLButtonElement);
    cancel?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onCancelCheck).toHaveBeenCalledTimes(1);
    expect(onCheck).not.toHaveBeenCalled();
  });

  it("sentence-cases fallback status values presented to the user", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        React.createElement(AudioToolsModal, {
          dependencies: [
            {
              ...dependency,
              state: "installed-unchecked",
              installedVersion: null,
              transient: { kind: "running", operation: "provision", percent: null },
            },
          ],
          checkUpdatesAtLaunch: true,
          isChecking: false,
          checkNotice: null,
          operationError: null,
          onProvision: vi.fn(),
          onCancelProvision: vi.fn(),
          onCheck: vi.fn(),
          onCancelCheck: vi.fn(),
          onToggleCheckUpdates: vi.fn(),
          onClose: vi.fn(),
        }),
      );
    });

    expect(document.body.textContent).toContain("Version unreadable");
    expect(document.body.textContent).toContain("Unknown");
    expect(document.body.textContent).toContain("Working…");
  });

  it("uses the fleet management title and presents rolling builds by date", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        React.createElement(AudioToolsModal, {
          dependencies: [{
            ...dependency,
            state: "update-available",
            installedVersion: "Latest Auto-Build (2026-08-23 13:03)",
            desiredVersion: "Latest Auto-Build (2026-08-24 14:04)",
            transient: { kind: "idle" },
          }],
          checkUpdatesAtLaunch: true,
          isChecking: false,
          checkNotice: null,
          operationError: null,
          onProvision: vi.fn(),
          onCancelProvision: vi.fn(),
          onCheck: vi.fn(),
          onCancelCheck: vi.fn(),
          onToggleCheckUpdates: vi.fn(),
          onClose: vi.fn(),
        }),
      );
    });

    expect(document.body.textContent).toContain("Managed tools");
    expect(document.body.textContent).toContain("2026-08-23 13:03");
    expect(document.body.textContent).toContain("2026-08-24 14:04");
    expect(document.body.textContent).not.toContain("Latest Auto-Build");
  });

  it("keeps a thrown tool operation failure inside the open modal as an alert", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        React.createElement(AudioToolsModal, {
          dependencies: [{ ...dependency, transient: { kind: "idle" } }],
          checkUpdatesAtLaunch: true,
          isChecking: false,
          checkNotice: null,
          operationError: "Another tool operation is already running.",
          onProvision: vi.fn(),
          onCancelProvision: vi.fn(),
          onCheck: vi.fn(),
          onCancelCheck: vi.fn(),
          onToggleCheckUpdates: vi.fn(),
          onClose: vi.fn(),
        }),
      );
    });

    const alert = document.querySelector('[role="dialog"] [role="alert"]');
    expect(alert?.textContent).toBe("Another tool operation is already running.");
  });
});
