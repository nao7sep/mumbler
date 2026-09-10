import { describe, expect, it, vi } from "vitest";

import { WINDOW_MIN_HEIGHT, WINDOW_MIN_WIDTH } from "@shared/layout";

// window.ts imports electron at module load; stub it so the pure helpers can be
// verified under the node test environment. createMainWindow is exercised here
// only to assert the forced theme, so the BrowserWindow stub is a no-op
// constructor and nativeTheme is a writable holder for themeSource.
const nativeThemeStub = { themeSource: "system" as string };
let documentLoadFailure: Error | null = null;

vi.mock("electron", () => ({
  BrowserWindow: class {
    private bounds = { x: 20, y: 30, width: 1480, height: 940 };
    on(): void {}
    once(): void {}
    off(): void {}
    getBounds() { return { ...this.bounds }; }
    getContentBounds() { return { ...this.bounds }; }
    getSize() { return [this.bounds.width, this.bounds.height]; }
    getMinimumSize() { return [WINDOW_MIN_WIDTH, WINDOW_MIN_HEIGHT]; }
    setMinimumSize(): void {}
    setSize(width: number, height: number) { this.bounds = { ...this.bounds, width, height }; }
    isMaximized() { return false; }
    isMinimized() { return false; }
    isFullScreen() { return false; }
    isDestroyed() { return false; }
    show(): void {}
    close(): void {}
    loadURL(): Promise<void> {
      return documentLoadFailure ? Promise.reject(documentLoadFailure) : Promise.resolve();
    }
    loadFile(): Promise<void> {
      return documentLoadFailure ? Promise.reject(documentLoadFailure) : Promise.resolve();
    }
    webContents = {
      setWindowOpenHandler(): void {},
      on(): void {},
      getURL(): string {
        return "";
      },
      session: { webRequest: { onHeadersReceived(): void {} } },
    };
  },
  Menu: { buildFromTemplate: () => ({ popup: () => {} }) },
  shell: { openExternal: vi.fn() },
  nativeTheme: nativeThemeStub,
  screen: {
    getDisplayMatching: () => ({ workAreaSize: { width: 2560, height: 1440 } }),
    on: vi.fn(), off: vi.fn(),
  },
}));

const { buildWindowOptions, createMainWindow, isAllowedExternalUrl, withContentSecurityPolicy } =
  await import("@main/window");
const runtime = {
  currentLogger: () => ({ warn: vi.fn(async () => undefined) }),
} as never;

describe("isAllowedExternalUrl", () => {
  it("allows only http, https, and mailto", () => {
    expect(isAllowedExternalUrl("https://example.com")).toBe(true);
    expect(isAllowedExternalUrl("http://example.com")).toBe(true);
    expect(isAllowedExternalUrl("mailto:a@b.com")).toBe(true);
  });

  it("rejects other schemes and malformed URLs", () => {
    expect(isAllowedExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedExternalUrl("smb://host/share")).toBe(false);
    expect(isAllowedExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedExternalUrl("not a url")).toBe(false);
    expect(isAllowedExternalUrl("")).toBe(false);
  });
});

describe("withContentSecurityPolicy", () => {
  it("stamps a single CSP header with the expected directives", () => {
    const headers = withContentSecurityPolicy(undefined);
    const csp = headers["Content-Security-Policy"];
    expect(csp).toHaveLength(1);

    const policy = csp[0];
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("script-src 'self'");
    // Audio is served from the custom scheme — it must be allowed for media+fetch.
    expect(policy).toContain("media-src 'self' mumbler-asset: blob:");
    expect(policy).toContain("connect-src 'self' mumbler-asset:");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    // Inline styles are needed (React/WaveSurfer) but inline scripts are not.
    expect(policy).toContain("style-src 'self' 'unsafe-inline'");
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
  });

  it("preserves existing response headers", () => {
    const headers = withContentSecurityPolicy({ "X-Test": ["1"], "Content-Type": ["text/html"] });
    expect(headers["X-Test"]).toEqual(["1"]);
    expect(headers["Content-Type"]).toEqual(["text/html"]);
    expect(headers["Content-Security-Policy"]).toHaveLength(1);
  });
});

describe("buildWindowOptions", () => {
  it("derives the window minimums from the shared layout (no magic constants)", () => {
    const options = buildWindowOptions();
    expect(options.minWidth).toBe(WINDOW_MIN_WIDTH);
    expect(options.minHeight).toBe(WINDOW_MIN_HEIGHT);
  });

  it("opens at the designed default size, never below its own minimum", () => {
    const options = buildWindowOptions();
    expect(options.width).toBe(1480);
    expect(options.height).toBe(940);
    expect(options.width).toBeGreaterThanOrEqual(WINDOW_MIN_WIDTH);
    expect(options.height).toBeGreaterThanOrEqual(WINDOW_MIN_HEIGHT);
  });
});

describe("createMainWindow", () => {
  it("forces the light theme so a dark host paints a light title bar", async () => {
    nativeThemeStub.themeSource = "system";
    await createMainWindow(runtime);
    expect(nativeThemeStub.themeSource).toBe("light");
  });

  it("keeps a renderer document-load rejection observable to startup", async () => {
    const hostile = new Error("EACCES /private/tmp/mumbler-renderer.html");
    documentLoadFailure = hostile;
    await expect(createMainWindow(runtime)).rejects.toBe(hostile);
    documentLoadFailure = null;
  });
});
