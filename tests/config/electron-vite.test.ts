import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LANGUAGES } from "@shared/i18n/languages";

import config from "../../electron.vite.config";

describe("Electron development endpoint", () => {
  it("owns a stable strict loopback port", () => {
    expect(config.renderer?.server).toMatchObject({ host: "127.0.0.1", port: 27259, strictPort: true });
  });
});

// electron-vite adds its CommonJS shims to the main bundle after the last text
// that its import-statement pattern matches (vite:esm-shim in electron-vite 5).
// The main process bundles the interface catalogues, so a catalogue line that
// ends in the word "import" right before its closing quote is taken for an
// import statement, and the shims land inside the catalogue, breaking the build.
// The pattern is copied from electron-vite; this keeps every catalogue clear of it.
const ESM_STATIC_IMPORT =
  /(?<=\s|^|;)import\s*([\s"']*(?<imports>[\p{L}\p{M}\w\t\n\r $*,/{}@.]+)from\s*)?["']\s*(?<specifier>(?<="\s*)[^"]*[^\s"](?=\s*")|(?<='\s*)[^']*[^\s'](?=\s*'))\s*["'][\s;]*/gmu;

describe("interface catalogues in the main bundle", () => {
  it.each(LANGUAGES)("%s has no line electron-vite would take for an import statement", (language) => {
    const text = readFileSync(join(process.cwd(), `src/shared/i18n/locales/${language}.json`), "utf8");
    expect([...text.matchAll(ESM_STATIC_IMPORT)].map((match) => match[0])).toEqual([]);
  });
});
