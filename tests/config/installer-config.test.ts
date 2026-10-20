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

describe("package scripts", () => {
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
