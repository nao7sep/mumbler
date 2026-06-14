import { describe, expect, it, vi } from "vitest";

// window.ts imports electron at module load; stub it so the pure hardening
// helpers can be verified under the node test environment. createMainWindow is
// never called here, so the stub only needs the named bindings to exist.
vi.mock("electron", () => ({
  BrowserWindow: class {},
  Menu: { buildFromTemplate: () => ({ popup: () => {} }) },
  shell: { openExternal: vi.fn() },
}));

const { isAllowedExternalUrl, withContentSecurityPolicy } = await import("@main/window");

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
