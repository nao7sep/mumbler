import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const config = readFileSync(
  new URL("../../electron-builder.yml", import.meta.url),
  "utf8",
);

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
