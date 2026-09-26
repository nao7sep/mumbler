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
  nativeTheme: { shouldUseDarkColors: false },
}));

import { renderStartupFailureHtml, showStartupFailureDialog } from "@main/startup-failure-dialog";
import { createTranslator } from "@shared/i18n/translate";

const english = createTranslator("en");

describe("startup failure dialog", () => {
  it("settles closed when its own document cannot load", async () => {
    await expect(showStartupFailureDialog(english)).resolves.toBe("close");
  });

  it("contains authored recovery copy, actions, and no severity icon or diagnostic", () => {
    const html = renderStartupFailureHtml(english);
    expect(html).toContain("Mumbler could not start");
    expect(html).toContain("Restart Mumbler");
    expect(html).toContain("Your recordings and saved files were not changed");
    expect(html).toContain('role="region" aria-label="Startup failure details" tabindex="0"');
    expect(html).toContain("*::-webkit-scrollbar{width:16px;height:16px}");
    expect(html).not.toContain("EACCES");
    expect(html).not.toMatch(/[⚠❌✅]/u);
  });

  it("softens every button palette while preserving primary intent when inactive", () => {
    const html = renderStartupFailureHtml(english);
    expect(html).toContain("data-window-inactive");
    expect(html).toMatch(/\[data-window-inactive\] \.button\{[^}]*background:#f2f5f2/);
    expect(html).toMatch(/\[data-window-inactive\] \.primary\{[^}]*background:#789580/);
    expect(html).toContain("toggleAttribute('data-window-inactive',!document.hasFocus())");
  });

  it("speaks the interface language and declares it", () => {
    const html = renderStartupFailureHtml(createTranslator("ja"));
    expect(html).toContain('<html lang="ja">');
    expect(html).toContain("Mumblerを起動できませんでした");
    expect(html).toContain(">Mumblerを再起動</button>");
    expect(html).not.toContain("Mumbler could not start");
  });
});
