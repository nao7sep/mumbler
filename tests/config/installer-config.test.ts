import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { LANGUAGES } from "@shared/i18n/languages";

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

/** The indented body of one top-level section of electron-builder.yml. */
function section(name: string): string {
  const match = new RegExp(`^${name}:\\n((?:[ #].*\\n|\\n)*)`, "m").exec(config);
  return match?.[1] ?? "";
}

describe("release artifact names", () => {
  it("names every artifact as the release naming contract says, with no arch suffix", () => {
    expect(section("mac")).toContain("  artifactName: ${productName}-${version}-mac.${ext}");
    expect(section("dmg")).toContain("  artifactName: ${productName}-${version}.${ext}");
    expect(section("win")).toContain("  artifactName: ${productName}-${version}-win.${ext}");
    expect(section("nsis")).toContain("  artifactName: ${productName}-${version}-setup.${ext}");
  });
});

describe("interface languages in the packaged app", () => {
  function listUnder(key: string): string[] {
    const lines = config.split("\n");
    const start = lines.findIndex((line) => line.trim() === `${key}:`);
    expect(start, key).toBeGreaterThanOrEqual(0);
    const items: string[] = [];
    for (const line of lines.slice(start + 1)) {
      const match = /^\s+- (\S+)$/.exec(line);
      if (!match) break;
      items.push(match[1]!);
    }
    return items;
  }

  it("declares exactly the language set in the macOS bundle", () => {
    expect(listUnder("CFBundleLocalizations")).toEqual([...LANGUAGES]);
  });

  it("builds the Windows installer in the same languages, English first", () => {
    const installer = listUnder("installerLanguages");
    expect(installer[0]).toBe("en_US");
    const asTags = installer.map((code) =>
      code === "pt_BR" ? "pt-BR" : code === "zh_CN" ? "zh-Hans" : code.split("_")[0],
    );
    expect(asTags).toEqual([...LANGUAGES]);
  });
});
