import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// A downloaded macOS binary must carry a native arm64 slice — the fleet is
// Apple-Silicon-only and macOS 28 drops Rosetta, so an x86_64-only build is a hard
// failure, not a Rosetta-tolerated fallback (managed-runtime-dependencies-
// conventions, "Architecture correctness"). A universal (fat) binary passes; only
// x86_64-only fails. `lipo -archs` is the inspection tool; this gate runs on the
// staged file before it is published, so a wrong-arch build is discarded like a
// bad checksum rather than published and left to fail at exec time.

// Pure parse of `lipo -archs` output (e.g. "arm64", "x86_64 arm64", "x86_64").
export function hasArm64Slice(lipoArchsOutput: string): boolean {
  return lipoArchsOutput.trim().split(/\s+/).filter(Boolean).includes("arm64");
}

export async function assertArm64Slice(filePath: string): Promise<void> {
  const { stdout } = await execFileAsync("lipo", ["-archs", filePath]);
  if (!hasArm64Slice(stdout)) {
    throw new Error(
      `downloaded binary is not arm64-native (lipo reports: ${stdout.trim() || "no slices"})`,
    );
  }
}
