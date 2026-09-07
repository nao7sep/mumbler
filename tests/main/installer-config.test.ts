import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const config = readFileSync(
  new URL("../../electron-builder.yml", import.meta.url),
  "utf8",
);
const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);

describe("packaged development metadata", () => {
  it("excludes source maps and TypeScript declarations", () => {
    for (const exclusion of ["!**/*.map", "!**/*.d.ts", "!**/*.d.mts", "!**/*.d.cts"]) {
      expect(config).toContain(`  - "${exclusion}"`);
    }
  });
});

describe("packaged license texts", () => {
  it("ships the app, Electron, and Chromium licenses", () => {
    for (const line of [
      "  - from: LICENSE",
      "    to: LICENSE.txt",
      "  - from: node_modules/electron/dist/LICENSE",
      "    to: electron/LICENSE",
      "  - from: node_modules/electron/dist/LICENSES.chromium.html",
      "    to: electron/LICENSES.chromium.html",
    ]) {
      expect(config).toContain(line);
    }
  });

  it("prepares Electron before every package-script builder invocation", () => {
    for (const script of Object.values(packageJson.scripts) as string[]) {
      if (script.includes("electron-builder")) {
        expect(script.indexOf("npm run prepare:electron")).toBeLessThan(
          script.indexOf("electron-builder"),
        );
      }
    }
  });
});

describe("Windows installer configuration", () => {
  it("uses the assisted dual-scope NSIS contract", () => {
    for (const setting of [
      "oneClick: false",
      "perMachine: false",
      "allowElevation: true",
      "createDesktopShortcut: true",
      "createStartMenuShortcut: true",
      "runAfterFinish: true",
    ]) {
      expect(config).toContain(`  ${setting}`);
    }
  });
});
