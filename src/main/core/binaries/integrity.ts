import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

// SHA-256 integrity for downloaded audio tools. The hash is the vendor's
// published per-asset checksum, fetched alongside the download (martin-riedl's
// `.zip.sha256` sidecar on macOS, BtbN's combined `checksums.sha256` on Windows)
// and verified at acquisition, before the bytes are made executable — the
// native-binary-and-model-delivery-conventions' integrity gate.

// Stream the file through the hash so a ~27 MB archive never sits in memory.
export async function sha256OfFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve());
  });
  return hash.digest("hex");
}

// A checksum file is one or more `<hex>  <filename>` lines (two spaces is the
// sha256sum convention, but tolerate any run of whitespace). Returns the hash for
// the named asset, or null when the file does not list it.
export function parseSha256Sidecar(text: string, assetName: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line.trim());
    if (match && match[2] === assetName) {
      return match[1].toLowerCase();
    }
  }
  return null;
}

export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrityError";
  }
}

// Verify a downloaded file against an expected hex digest. A mismatch throws and
// aborts the install — never a warning the caller can click past.
export async function verifySha256(filePath: string, expectedHex: string): Promise<void> {
  const expected = expectedHex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw new IntegrityError(`malformed expected SHA-256: ${expectedHex}`);
  }
  const actual = await sha256OfFile(filePath);
  if (actual !== expected) {
    throw new IntegrityError(`SHA-256 mismatch: expected ${expected}, got ${actual}`);
  }
}
