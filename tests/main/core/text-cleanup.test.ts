import { describe, expect, it } from "vitest";

import { multiline } from "@main/core/text-cleanup";

// Covers the multiline behaviors mumbler relies on at its commit points
// (transcript + structured outline storage, prompt-template saves): trailing-end
// trim, edge-blank drop, interior-blank preservation, whitespace-only-as-blank,
// CRLF normalization, indentation preservation — and the regression that motivated
// the convention: a scalar .trim() eats a multi-line body's first-line indentation
// where multiline preserves it.
describe("multiline", () => {
  it("trims each line's trailing whitespace", () => {
    expect(multiline("a  \nb\t\nc")).toBe("a\nb\nc");
  });

  it("keeps trailing whitespace when trimLineEnds is off (Markdown hard breaks)", () => {
    expect(multiline("a  \nb  ", { trimLineEnds: false })).toBe("a  \nb  ");
  });

  it("drops blank lines before the first and after the last visible line", () => {
    expect(multiline("\n\n  hello  \n\n")).toBe("  hello");
  });

  it("preserves interior blank runs by default (deliberate section breaks)", () => {
    expect(multiline("a\n\n\nb")).toBe("a\n\n\nb");
  });

  it("collapses interior blank runs to one when collapseBlankLines is on", () => {
    expect(multiline("a\n\n\nb", { collapseBlankLines: true })).toBe("a\n\nb");
  });

  it("treats a whitespace-only line as blank (spaces and full-width U+3000)", () => {
    // Interior whitespace-only lines survive as blank lines (trimmed to empty),
    // and a whitespace-only edge line is dropped like a truly empty one.
    expect(multiline("a\n   \nb")).toBe("a\n\nb");
    expect(multiline("a\n　\nb")).toBe("a\n\nb");
    expect(multiline("　\na\n   ")).toBe("a");
  });

  it("normalizes CRLF and lone CR to LF", () => {
    expect(multiline("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  it("preserves leading indentation on every line", () => {
    expect(multiline("  indented\n    more")).toBe("  indented\n    more");
  });

  it("returns empty for an all-blank body", () => {
    expect(multiline("   \n　\n  ")).toBe("");
  });

  it("preserves the first content line's indentation that a scalar .trim() would eat", () => {
    // This is the wrong-pattern regression the convention guards against. A body
    // whose first content line is indented and whose interior lines have trailing
    // whitespace: scalar .trim() removes the leading "\n" and the next line's
    // indentation as one run (and leaves interior trailing spaces), while multiline
    // keeps the indentation and strips only the per-line trailing whitespace.
    const body = "\n    first line  \n        second line\n";

    expect(body.trim()).toBe("first line  \n        second line");
    expect(multiline(body)).toBe("    first line\n        second line");
  });
});
