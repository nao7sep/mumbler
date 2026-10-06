import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {
    webContents = { on: vi.fn(), once: vi.fn(), executeJavaScript: vi.fn() };
    on(): void {}
    isDestroyed(): boolean { return false; }
    close(): void {}
    loadURL(): Promise<void> { return Promise.reject(new Error("no page")); }
  },
  screen: { getPrimaryDisplay: () => ({ workArea: { height: 900 } }) },
  nativeTheme: { shouldUseDarkColors: false },
}));

import { renderPlainDialogHtml, showPlainDialog, type PlainDialog } from "@main/plain-dialog";

const dialog: PlainDialog<"cancel" | "retry" | "quit-anyway"> = {
  language: "de",
  title: "Mumbler wurde nicht beendet",
  bodyLabel: "Details zum Beenden",
  body: "Mumbler konnte <die Warteschlange> nicht speichern.",
  actions: [
    { choice: "cancel", label: "Abbrechen" },
    { choice: "retry", label: "Erneut versuchen", tone: "primary" },
    { choice: "quit-anyway", label: "Trotzdem beenden", tone: "danger" },
  ],
  focus: "retry",
  dismiss: "cancel",
};

describe("plain dialog", () => {
  it("never cuts a button: the footer wraps a button that does not fit, and a long label wraps inside its button", () => {
    const html = renderPlainDialogHtml(dialog);

    expect(html).toMatch(/\.actions\{[^}]*flex-wrap:wrap/);
    expect(html).toMatch(/\.button\{[^}]*max-width:100%;overflow-wrap:anywhere/);
    expect(html).not.toMatch(/white-space:nowrap|text-overflow/);
  });

  it("lays the actions out in order, the destructive one last and red, each focusable by its choice", () => {
    const html = renderPlainDialogHtml(dialog);
    const buttons = [...html.matchAll(/<button id="choice-([\w-]+)" class="([^"]+)"/g)].map((match) => [match[1], match[2]]);

    expect(buttons).toEqual([["cancel", "button"], ["retry", "button primary"], ["quit-anyway", "button danger"]]);
    expect(html).toMatch(/\.danger\{color:white;background:#a44335/);
    expect(html).toContain('<html lang="de">');
    expect(html).toContain("&lt;die Warteschlange&gt;");
  });

  it("settles with its dismiss choice when its page cannot load", async () => {
    await expect(showPlainDialog(dialog).choice).resolves.toBe("cancel");
  });
});
