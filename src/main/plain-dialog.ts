import { BrowserWindow, nativeTheme, screen } from "electron";

import type { Language } from "@shared/i18n/languages";

// The app's own plain dialog shell (modal-dialog conventions): a small window
// of its own, with no framework or application severity icon, that works with
// or without the main window. Its page follows prefers-color-scheme, which
// follows nativeTheme.themeSource.

export interface PlainDialogAction<C extends string> {
  choice: C;
  label: string;
  tone?: "primary" | "danger";
}

export interface PlainDialog<C extends string> {
  language: Language;
  title: string;
  /** The accessible name of the scrolling body. */
  bodyLabel: string;
  body: string;
  detail?: string;
  /** In footer order: the cancel or secondary action first. */
  actions: readonly PlainDialogAction<C>[];
  /** The control focused on open; never a destructive one. */
  focus: C;
  /** The choice Escape and closing the window make. */
  dismiss: C;
}

export interface OpenPlainDialog<C extends string> {
  choice: Promise<C>;
  /** Closes the dialog, which settles it with its dismiss choice. */
  close(): void;
}

const CHOICE_ORIGIN = "https://mumbler-dialog.invalid/choice/";
const WIDTH = 520;
const MIN_HEIGHT = 220;

export function showPlainDialog<C extends string>(dialog: PlainDialog<C>): OpenPlainDialog<C> {
  const win = new BrowserWindow({
    show: false,
    width: WIDTH,
    height: 260,
    minWidth: 420,
    minHeight: MIN_HEIGHT,
    maxWidth: 680,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    title: dialog.title,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#111814" : "#edf4ec",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const choices = new Set<string>(dialog.actions.map((action) => action.choice));

  const choice = new Promise<C>((resolve) => {
    let settled = false;
    const settle = (picked: C): void => {
      if (settled) return;
      settled = true;
      resolve(picked);
      if (!win.isDestroyed()) win.close();
    };
    const fail = (phase: string, error: unknown): void => {
      console.error(`[mumbler] plain dialog ${phase} failed:`, error);
      settle(dialog.dismiss);
    };

    win.on("closed", () => settle(dialog.dismiss));
    win.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith(CHOICE_ORIGIN)) return;
      event.preventDefault();
      const picked = url.slice(CHOICE_ORIGIN.length);
      settle(choices.has(picked) ? (picked as C) : dialog.dismiss);
    });
    win.webContents.on("before-input-event", (event, input) => {
      if (input.key !== "Escape") return;
      event.preventDefault();
      settle(dialog.dismiss);
    });
    win.webContents.once("dom-ready", () => {
      void win.webContents.executeJavaScript(
        "document.getElementById('dialog-header').offsetHeight + document.getElementById('dialog-body').scrollHeight + document.getElementById('dialog-footer').offsetHeight",
        true,
      ).then((height: number) => {
        if (win.isDestroyed()) return;
        const displayHeight = screen.getPrimaryDisplay().workArea.height;
        win.setContentSize(WIDTH, Math.min(Math.max(Math.ceil(height), MIN_HEIGHT), Math.floor(displayHeight * 0.85)));
        win.show();
        return win.webContents.executeJavaScript(
          `document.getElementById(${JSON.stringify(`choice-${dialog.focus}`)})?.focus()`,
          true,
        );
      }).catch((error: unknown) => fail("measurement", error));
    });
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderPlainDialogHtml(dialog))}`)
      .catch((error: unknown) => fail("load", error));
  });

  return {
    choice,
    close: () => {
      if (!win.isDestroyed()) win.close();
    },
  };
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// The page is drawn in the interface language, and declares it so Chinese,
// Japanese and Korean text takes its own glyphs. The footer wraps a button that
// does not fit onto its own row, and a label longer than the row wraps inside
// its button, so no label is ever cut.
export function renderPlainDialogHtml<C extends string>(dialog: PlainDialog<C>): string {
  const buttons = dialog.actions.map((action) => {
    const tone = action.tone === undefined ? "" : ` ${action.tone}`;
    return `<button id="choice-${escapeHtml(action.choice)}" class="button${tone}" type="button" onclick="location.href='${CHOICE_ORIGIN}${escapeHtml(action.choice)}'">${escapeHtml(action.label)}</button>`;
  }).join("");
  const detail = dialog.detail === undefined ? "" : `<p class="detail">${escapeHtml(dialog.detail)}</p>`;
  return `<!doctype html><html lang="${dialog.language}"><head><meta charset="utf-8"><style>
    :root{color-scheme:light;font:14px/1.5 system-ui,-apple-system,sans-serif;background:#edf4ec;color:#1f2a21}
    *{box-sizing:border-box;scrollbar-width:auto;scrollbar-color:#477552 transparent}*::-webkit-scrollbar{width:16px;height:16px}*::-webkit-scrollbar-thumb{background:#477552;background-clip:padding-box;border:3px solid transparent;border-radius:999px}
    body{margin:0;height:100vh;overflow:hidden}.dialog{height:100vh;display:grid;grid-template-rows:auto minmax(0,1fr) auto}
    .header{padding:24px 24px 12px}.body{min-height:0;overflow:auto;padding:0 24px;display:flex;flex-direction:column;gap:12px}[role="region"]:focus-visible{outline:none}
    h1{font-size:18px;line-height:1.3;margin:0}p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.detail{color:#526356}
    .actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;padding:12px 24px 24px}.button{max-width:100%;overflow-wrap:anywhere;color:#1f2a21;border:1px solid #9baa9e;border-radius:6px;padding:7px 14px;background:#f7faf7;font:inherit}
    .button:hover,.button:focus{outline:2px solid #477552;outline-offset:2px}.primary{color:white;background:#376d45;border-color:#2f5e3b}.primary:hover,.primary:focus{background:#2f5e3b}.danger{color:white;background:#a44335;border-color:#8e392d}.danger:hover,.danger:focus{background:#8e392d}
    [data-window-inactive] .button{color:#69756b;border-color:#c0c9c1;background:#f2f5f2}[data-window-inactive] .button:focus{outline-color:#9aaba0}
    [data-window-inactive] .primary{color:#eef3ef;background:#789580;border-color:#6e8a76}[data-window-inactive] .primary:hover,[data-window-inactive] .primary:focus{background:#708c78}
    [data-window-inactive] .danger{color:#f6ecea;background:#b9786e;border-color:#ab6b61}[data-window-inactive] .danger:hover,[data-window-inactive] .danger:focus{background:#b26f65}
    @media (prefers-color-scheme:dark){:root{color-scheme:dark;background:#111814;color:#e4ede5}*{scrollbar-color:#94a596 transparent}*::-webkit-scrollbar-thumb{background:#94a596;background-clip:padding-box}.detail{color:#b0c0b2}.button{color:#e4ede5;border-color:#5f7563;background:#1c2821}.button:hover,.button:focus{outline-color:#94a596}.danger{color:white;background:#b04a3f;border-color:#984036}.danger:hover,.danger:focus{background:#984036}[data-window-inactive] .button{color:#94a596;border-color:#33453a;background:#16201a}[data-window-inactive] .button:focus{outline-color:#5f7563}[data-window-inactive] .primary{color:#dfe8e0;background:#3f5a47;border-color:#4a6853}[data-window-inactive] .primary:hover,[data-window-inactive] .primary:focus{background:#3f5a47}[data-window-inactive] .danger{color:#ecdcd9;background:#6e3c35;border-color:#7d443c}[data-window-inactive] .danger:hover,[data-window-inactive] .danger:focus{background:#6e3c35}}
  </style></head><body><main class="dialog"><header class="header" id="dialog-header"><h1>${escapeHtml(dialog.title)}</h1></header><section class="body" id="dialog-body" role="region" aria-label="${escapeHtml(dialog.bodyLabel)}" tabindex="0"><p>${escapeHtml(dialog.body)}</p>${detail}</section><footer class="actions" id="dialog-footer">${buttons}</footer></main><script>const syncWindowState=()=>document.documentElement.toggleAttribute('data-window-inactive',!document.hasFocus());addEventListener('focus',syncWindowState);addEventListener('blur',syncWindowState);syncWindowState();</script></body></html>`;
}
