// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DependencyStatus, ToolTransient } from "@shared/app-shell";
import { deriveStatus } from "@shared/dependency-status";
import { ToolsChip } from "@renderer/app/ToolsChip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const upToDate = (transient: ToolTransient = { kind: "idle" }): DependencyStatus =>
  deriveStatus("ffmpeg", true, { present: true, installedVersion: "8.2", desiredVersion: "8.2", lastCheckedAtUtc: 1 }, transient);
const missing = (transient: ToolTransient = { kind: "idle" }): DependencyStatus =>
  deriveStatus("ffprobe", true, { present: false, installedVersion: null, desiredVersion: null, lastCheckedAtUtc: null }, transient);
const checking: ToolTransient = { kind: "running", operation: "check", percent: null };
const provisioning: ToolTransient = { kind: "running", operation: "provision", percent: 10 };

async function show(dependencies: DependencyStatus[], viewOpen: boolean, requested = false): Promise<string | null> {
  await act(async () => root.render(React.createElement(ToolsChip, { dependencies, checking: requested, viewOpen, onOpen: vi.fn() })));
  return container.querySelector(".tools-chip")?.textContent ?? null;
}

describe("the Managed tools chip", () => {
  it("shows work in progress while Managed tools is closed, and returns to rest when it ends", async () => {
    expect(await show([upToDate(checking)], false)).toBe("Managed tools: checking for updates…");
    expect(await show([upToDate()], false), "an up-to-date set is quiet again").toBeNull();
    expect(await show([missing(provisioning)], false)).toBe("Managed tools: installing…");
    expect(await show([missing()], false)).toBe("Managed tools: action needed");
  });

  it("keeps its resting state while Managed tools is open, so a quick check does not flash behind it", async () => {
    expect(await show([upToDate(checking)], true)).toBeNull();
    expect(await show([missing(provisioning)], true)).toBe("Managed tools: action needed");
    expect(await show([upToDate()], true, true)).toBeNull();
  });

  it("shows a check the app has asked for before any tool reports it", async () => {
    expect(await show([upToDate()], false, true)).toBe("Managed tools: checking for updates…");
  });
});
