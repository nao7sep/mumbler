import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";

import unzipper from "unzipper";

// Extract a single named file from a zip to outPath. Resolves the entry by exact
// path first, then by basename suffix (so a binary nested as
// `ffmpeg-master/bin/ffmpeg.exe` is found by `ffmpeg.exe`). A basename matching
// more than one entry, with no exact match to disambiguate, throws rather than
// extracting whichever the archive happened to list first. Atomicity and
// crash-durability are the caller's concern; this only lands the decompressed
// bytes at outPath.
export async function extractFileFromZip(
  zipPath: string,
  innerName: string,
  outPath: string,
): Promise<void> {
  const directory = await unzipper.Open.file(zipPath);
  const files = directory.files.filter((file) => file.type === "File");
  const byBasename = files.filter((file) => file.path.endsWith("/" + innerName));
  const file =
    files.find((entry) => entry.path === innerName) ??
    (byBasename.length === 1 ? byBasename[0] : undefined);

  if (!file) {
    if (byBasename.length > 1) {
      throw new Error(
        `File ${innerName} matches multiple entries in archive: ${byBasename.map((f) => f.path).join(", ")}`,
      );
    }
    throw new Error(
      `File ${innerName} not found in archive. Available: ${files.map((f) => f.path).join(", ")}`,
    );
  }

  await pipeline(file.stream(), createWriteStream(outPath));
}
