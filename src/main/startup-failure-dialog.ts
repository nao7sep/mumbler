import { BrowserWindow, screen } from "electron";

export type StartupFailureChoice = "restart" | "close";

const CHOICE_ORIGIN = "https://mumbler-startup.invalid/choice/";

/** Plain fatal-startup surface with no framework/application severity icon. */
export async function showStartupFailureDialog(): Promise<StartupFailureChoice> {
  const win = new BrowserWindow({
    show: false,
    width: 520,
    height: 260,
    minWidth: 420,
    minHeight: 220,
    maxWidth: 680,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    title: "Mumbler could not start",
    backgroundColor: "#edf4ec",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  return await new Promise<StartupFailureChoice>((resolve) => {
    let settled = false;
    const settle = (choice: StartupFailureChoice): void => {
      if (settled) return;
      settled = true;
      resolve(choice);
      if (!win.isDestroyed()) win.close();
    };
    const fail = (phase: string, error: unknown): void => {
      console.error(`[mumbler] startup failure dialog ${phase} failed:`, error);
      settle("close");
    };

    win.on("closed", () => settle("close"));
    win.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith(CHOICE_ORIGIN)) return;
      event.preventDefault();
      settle(url.endsWith("restart") ? "restart" : "close");
    });
    win.webContents.on("before-input-event", (event, input) => {
      if (input.key !== "Escape") return;
      event.preventDefault();
      settle("close");
    });
    win.webContents.once("dom-ready", () => {
      void win.webContents.executeJavaScript(
        "document.getElementById('dialog-header').offsetHeight + document.getElementById('dialog-body').scrollHeight + document.getElementById('dialog-footer').offsetHeight",
        true,
      ).then((height: number) => {
        if (win.isDestroyed()) return;
        const displayHeight = screen.getPrimaryDisplay().workArea.height;
        win.setContentSize(520, Math.min(Math.max(Math.ceil(height), 220), Math.floor(displayHeight * 0.85)));
        win.show();
        return win.webContents.executeJavaScript("document.getElementById('choice-restart')?.focus()", true);
      }).catch((error: unknown) => fail("measurement", error));
    });
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderStartupFailureHtml())}`)
      .catch((error: unknown) => fail("load", error));
  });
}

export function renderStartupFailureHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    :root{color-scheme:light;font:14px/1.5 system-ui,-apple-system,sans-serif;background:#edf4ec;color:#1f2a21}
    *{box-sizing:border-box}body{margin:0;height:100vh;overflow:hidden}.dialog{height:100vh;display:grid;grid-template-rows:auto minmax(0,1fr) auto}
    .header{padding:24px 24px 12px}.body{min-height:0;overflow:auto;padding:0 24px;display:flex;flex-direction:column;gap:12px}
    h1{font-size:18px;line-height:1.3;margin:0}p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.detail{color:#526356}
    .actions{display:flex;justify-content:flex-end;gap:8px;padding:12px 24px 24px}.button{color:#1f2a21;border:1px solid #9baa9e;border-radius:6px;padding:7px 14px;background:#f7faf7;font:inherit}
    .button:hover,.button:focus{outline:2px solid #477552;outline-offset:2px}.primary{color:white;background:#376d45;border-color:#2f5e3b}.primary:hover,.primary:focus{background:#2f5e3b}
  </style></head><body><main class="dialog"><header class="header" id="dialog-header"><h1>Mumbler could not start</h1></header><section class="body" id="dialog-body"><p>Mumbler could not finish opening its saved state or window.</p><p class="detail">Your recordings and saved files were not changed. Restart Mumbler to try again, or close it and inspect the session log.</p></section><footer class="actions" id="dialog-footer"><button class="button" type="button" onclick="location.href='${CHOICE_ORIGIN}close'">Close</button><button id="choice-restart" class="button primary" type="button" onclick="location.href='${CHOICE_ORIGIN}restart'">Restart Mumbler</button></footer></main></body></html>`;
}
