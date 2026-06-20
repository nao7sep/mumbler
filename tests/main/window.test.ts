import { describe, expect, it, vi } from "vitest";

import { WINDOW_MIN_HEIGHT, WINDOW_MIN_WIDTH } from "@shared/layout";

// window.ts imports electron at module load; stub it so the pure helpers can be
// verified under the node test environment. createMainWindow is exercised here
// only to assert the forced theme, so the BrowserWindow stub is a no-op
// constructor and nativeTheme is a writable holder for themeSource.
const nativeThemeStub = { themeSource: "system" as string };

vi.mock("electron", () => ({
  BrowserWindow: class {
    on(): void {}
    once(): void {}
    loadURL(): void {}
    loadFile(): void {}
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
}));

const { buildWindowOptions, createMainWindow, isAllowedExternalUrl, withContentSecurityPolicy } =
  await import("@main/window");

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
  it("forces the light theme so a dark host paints a light title bar", () => {
    nativeThemeStub.themeSource = "system";
    createMainWindow();
    expect(nativeThemeStub.themeSource).toBe("light");
  });
});
