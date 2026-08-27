export const AUDIO_IMPORT_EXTENSIONS = [
  "mp3",
  "m4a",
  "aac",
  "wav",
  "flac",
  "ogg",
  "oga",
  "aif",
  "aiff",
  "mp4",
] as const;

const supportedExtensions = new Set(AUDIO_IMPORT_EXTENSIONS.map((extension) => `.${extension}`));

/** The explicit file-type boundary shared by picker, drag preview, and final host import. */
export function isSupportedAudioImportName(pathOrName: string): boolean {
  const normalized = pathOrName.trim().toLowerCase();
  const separator = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  const name = normalized.slice(separator + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 && supportedExtensions.has(name.slice(dot));
}
