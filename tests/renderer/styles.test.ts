import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// Asserts the window-chrome conventions are present in the renderer stylesheet:
// a thin, rounded, themed scroll bar, a preserved light color-scheme, and a
// detail grid track that carries a real minimum (never minmax(0, 1fr), which
// would let the detail pane collapse to zero width).
const css = readFileSync(
  resolve("src/renderer/src/styles.css"),
  "utf8",
);

describe("styles.css window chrome", () => {
  it("declares the light color scheme", () => {
    expect(css).toContain("color-scheme: light");
  });

  it("styles a thin, rounded, inset scroll bar", () => {
    expect(css).toContain("::-webkit-scrollbar");
    expect(css).toContain("border-radius: 999px");
    expect(css).toContain("background-clip: padding-box");
    expect(css).toContain("scrollbar-width: thin");
  });

  it("gives the detail workspace track a real minimum, not a zero floor", () => {
    expect(css).not.toContain("400px minmax(0, 1fr)");
    expect(css).toContain("minmax(var(--detail-min-width), 1fr)");
  });
});
