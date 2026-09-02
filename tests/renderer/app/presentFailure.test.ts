/// <reference path="../../../src/renderer/src/vite-env.d.ts" />
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { presentFailure } from "@renderer/app/presentFailure";

afterEach(() => {
  delete (window as unknown as { mumbler?: unknown }).mumbler;
  vi.restoreAllMocks();
});

describe("presentFailure", () => {
  it("preserves diagnostic type and cause while returning authored presentation", () => {
    const reportRendererDiagnostic = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "mumbler", { configurable: true, value: { reportRendererDiagnostic } });
    const cause = new TypeError("EACCES /private/tmp/MUMBLER_CAUSE_SENTINEL");
    const error = new RangeError("Error invoking remote method MUMBLER_SENTINEL", { cause });

    const result = presentFailure(error, "The recording could not be saved. Try again.", "recording save failed");

    expect(result).toBe("The recording could not be saved. Try again.");
    expect(result).not.toMatch(/EACCES|private\/tmp|SENTINEL|invoking remote method/i);
    expect(reportRendererDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      name: "RangeError",
      message: expect.stringContaining("MUMBLER_SENTINEL"),
      cause: expect.objectContaining({ name: "TypeError", message: expect.stringContaining("MUMBLER_CAUSE_SENTINEL") }),
    }));
  });

  it("falls back to the console when diagnostic IPC rejects", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reportRendererDiagnostic = vi.fn().mockRejectedValue(new Error("bridge rejected"));
    Object.defineProperty(window, "mumbler", { configurable: true, value: { reportRendererDiagnostic } });

    presentFailure(new Error("original diagnostic"), "Authored copy", "test source");
    await Promise.resolve();

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("could not be recorded"),
      expect.objectContaining({ diagnostic: expect.objectContaining({ message: "original diagnostic" }) }),
    );
  });
});
