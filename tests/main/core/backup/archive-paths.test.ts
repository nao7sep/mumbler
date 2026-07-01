// The mirror-layout mapping: home files map straight from their relative path onto the archive root.

import { describe, it, expect } from "vitest";
import { forHomeFile, normalize } from "@main/core/backup/archive-paths.js";

describe("archivePaths", () => {
  it("keeps a home file at its relative path", () => {
    expect(forHomeFile("config.json")).toBe("config.json");
    expect(forHomeFile("state.json")).toBe("state.json");
    expect(forHomeFile("sub/x.json")).toBe("sub/x.json");
  });

  it("normalizes backslashes and a leading slash", () => {
    expect(normalize("a\\b\\c.txt")).toBe("a/b/c.txt");
    expect(normalize("/config.json")).toBe("config.json");
    expect(forHomeFile("sub\\x.json")).toBe("sub/x.json");
  });
});
