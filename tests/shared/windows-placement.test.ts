import { describe, expect, it } from "vitest";
import { normalizeWindowsNormalBounds } from "@shared/windows-placement";

describe("Windows native workspace rectangle", () => {
  it.each([
    { left: 111, top: 101, right: 1613, bottom: 1038 },
    { left: -1900, top: -100, right: -600, bottom: 800 },
    { left: 100000, top: 100000, right: 101200, bottom: 100800 },
  ])("preserves native coordinates without display/DPI arithmetic: %o", (bounds) => {
    expect(normalizeWindowsNormalBounds(bounds)).toEqual(bounds);
    expect(normalizeWindowsNormalBounds(bounds)).not.toBe(bounds);
  });
  it.each([null, undefined, [], {}, "bounds", { left: 1, top: 2, right: 3 },
    { left: NaN, top: 0, right: 100, bottom: 100 },
    { left: 0.5, top: 0, right: 100, bottom: 100 },
    { left: -2147483649, top: 0, right: 0, bottom: 100 },
    { left: 0, top: 0, right: 2147483648, bottom: 100 },
    { left: 0, top: 0, right: 0, bottom: 100 },
    { left: 100, top: 0, right: 0, bottom: 100 },
    { left: 0, top: 100, right: 100, bottom: 0 },
    { left: -2147483648, top: 0, right: 2147483647, bottom: 100 },
  ])("discards malformed native state without coercion: %o", (value) => {
    expect(normalizeWindowsNormalBounds(value)).toBeNull();
  });
});
