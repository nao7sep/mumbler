import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// A rule the whole stylesheet keeps, wherever a new control is styled.
const css = readFileSync(
  resolve("src/renderer/src/styles.css"),
  "utf8",
);

describe("the stylesheet's cursors", () => {
  it("never shows the forbidden cursor on a disabled control", () => {
    // Disabled controls fall through to the global plain-arrow rule.
    expect(css).not.toMatch(/cursor:\s*not-allowed/);
  });
});
