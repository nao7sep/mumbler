import { describe, expect, it } from "vitest";

import { AUDIO_IMPORT_EXTENSIONS, isSupportedAudioImportName } from "@shared/audio-import";

describe("audio import boundary", () => {
  it("keeps the picker list and final path validation case-insensitively aligned", () => {
    for (const extension of AUDIO_IMPORT_EXTENSIONS) {
      expect(isSupportedAudioImportName(`/recordings/sample.${extension.toUpperCase()}`)).toBe(true);
    }
    expect(isSupportedAudioImportName("C:\\recordings\\sample.wav")).toBe(true);
  });

  it("rejects missing, disguised, and unsupported extensions", () => {
    expect(isSupportedAudioImportName("sample")).toBe(false);
    expect(isSupportedAudioImportName(".wav")).toBe(false);
    expect(isSupportedAudioImportName("sample.wav.txt")).toBe(false);
    expect(isSupportedAudioImportName("notes.txt")).toBe(false);
  });
});
