import { describe, expect, it } from "vitest";

import { hasArm64Slice } from "@main/core/binaries/arch";

// The gate accepts a binary that carries a native arm64 slice (thin or universal)
// and rejects an x86_64-only build — the parse of `lipo -archs` output.
describe("hasArm64Slice", () => {
  it("accepts a thin arm64 binary", () => {
    expect(hasArm64Slice("arm64\n")).toBe(true);
  });

  it("accepts a universal binary that contains arm64, in either order", () => {
    expect(hasArm64Slice("x86_64 arm64")).toBe(true);
    expect(hasArm64Slice("arm64 x86_64")).toBe(true);
  });

  it("rejects an x86_64-only binary", () => {
    expect(hasArm64Slice("x86_64")).toBe(false);
  });

  it("rejects empty or whitespace-only output", () => {
    expect(hasArm64Slice("")).toBe(false);
    expect(hasArm64Slice("   \n")).toBe(false);
  });
});
