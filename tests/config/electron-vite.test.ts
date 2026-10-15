import { readdirSync, readFileSync } from "node:fs";
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

// The same pattern over the main bundle's own sources: only a real import
// statement, at the start of its line, may match. A comment or string such as
// "a pending import's" opens a quote the pattern runs on to the next
// apostrophe, and the shims then land inside that later code.
describe("main-process sources in the main bundle", () => {
  const files = (dir: string): string[] => readdirSync(join(process.cwd(), dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : []);

  it.each(["src/main", "src/shared", "src/preload"].flatMap(files))("%s has no text electron-vite would take for an import statement", (file) => {
    const text = readFileSync(join(process.cwd(), file), "utf8");
    const stray = [...text.matchAll(ESM_STATIC_IMPORT)]
      .filter((match) => !(match.index === 0 || text[match.index - 1] === "\n") || !/^import[\s{*]/.test(match[0]))
      .map((match) => match[0].slice(0, 60));
    expect(stray).toEqual([]);
  });
});
