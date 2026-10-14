import { describe, expect, it, vi } from "vitest";

const windows = vi.hoisted(() => ({
  loads: true as boolean,
  last: null as null | { calls: string[]; ready: () => void; scripts: string[] },
}));

vi.mock("electron", () => ({
  BrowserWindow: class {
    calls: string[] = [];
    scripts: string[] = [];
    ready: () => void = () => undefined;
    webContents = {
      on: vi.fn(),
      once: (event: string, handler: () => void) => { if (event === "dom-ready") this.ready = handler; },
      executeJavaScript: (script: string) => { this.scripts.push(script); return Promise.resolve(240); },
    };
    constructor() { windows.last = this; }
    on(): void {}
    isDestroyed(): boolean { return false; }
    close(): void {}
    show(): void { this.calls.push("show"); }
    showInactive(): void { this.calls.push("showInactive"); }
    setContentSize(): void {}
    loadURL(): Promise<void> { return windows.loads ? Promise.resolve() : Promise.reject(new Error("no page")); }
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
    windows.loads = false;
    try {
      await expect(showPlainDialog(dialog).choice).resolves.toBe("cancel");
    } finally {
      windows.loads = true;
    }
  });

  // window-conventions: a question the user's own action raised opens as the
  // key window, Electron's show() activating the app, with its default choice focused.
  it("opens activated, as the key window, with its default choice focused", async () => {
    showPlainDialog(dialog);
    const window = windows.last!;
    window.ready();
    await vi.waitFor(() => expect(window.scripts).toHaveLength(2));
    expect(window.calls).toEqual(["show"]);
    expect(window.scripts[1]).toContain('"choice-retry"');
  });
});
