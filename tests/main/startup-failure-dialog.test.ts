import { describe, expect, it, vi } from "vitest";

const hostile = new Error("EACCES /private/tmp/startup-dialog.html");

vi.mock("electron", () => ({
  BrowserWindow: class {
    webContents = {
      on: vi.fn(),
      once: vi.fn(),
      executeJavaScript: vi.fn(),
    };
    on(): void {}
    isDestroyed(): boolean { return false; }
    close(): void {}
    loadURL(): Promise<void> { return Promise.reject(hostile); }
    setContentSize(): void {}
    show(): void {}
  },
  screen: { getPrimaryDisplay: () => ({ workArea: { height: 900 } }) },
}));

import { renderStartupFailureHtml, showStartupFailureDialog } from "@main/startup-failure-dialog";

describe("startup failure dialog", () => {
  it("settles closed when its own document cannot load", async () => {
    await expect(showStartupFailureDialog()).resolves.toBe("close");
  });

  it("contains authored recovery copy, actions, and no severity icon or diagnostic", () => {
    const html = renderStartupFailureHtml();
    expect(html).toContain("Mumbler could not start");
    expect(html).toContain("Restart Mumbler");
    expect(html).toContain("Your recordings and saved files were not changed");
    expect(html).not.toContain("EACCES");
    expect(html).not.toMatch(/[⚠❌✅]/u);
  });

  it("softens every button palette while preserving primary intent when inactive", () => {
    const html = renderStartupFailureHtml();
    expect(html).toContain("data-window-inactive");
    expect(html).toMatch(/\[data-window-inactive\] \.button\{[^}]*background:#f2f5f2/);
    expect(html).toMatch(/\[data-window-inactive\] \.primary\{[^}]*background:#789580/);
    expect(html).toContain("toggleAttribute('data-window-inactive',!document.hasFocus())");
  });
});
