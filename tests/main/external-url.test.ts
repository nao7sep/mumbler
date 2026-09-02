import { beforeEach, describe, expect, it, vi } from "vitest";

const openExternal = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({ shell: { openExternal } }));

import { isAllowedExternalUrl, openExternalUrl } from "@main/external-url";

beforeEach(() => openExternal.mockReset());

describe("external URL boundary", () => {
  it("awaits the OS handler and preserves its rejection", async () => {
    const hostile = new Error("EACCES /private/tmp/browser-handler");
    openExternal.mockRejectedValueOnce(hostile);
    await expect(openExternalUrl("https://example.com")).rejects.toBe(hostile);
  });

  it("allows web and mail URLs but rejects local or executable schemes", async () => {
    expect(isAllowedExternalUrl("https://example.com")).toBe(true);
    expect(isAllowedExternalUrl("mailto:a@example.com")).toBe(true);
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "not a url"]) {
      await expect(openExternalUrl(url)).rejects.toThrow("not allowed");
    }
    expect(openExternal).not.toHaveBeenCalled();
  });
});
