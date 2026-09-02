import { shell } from "electron";

const ALLOWED_EXTERNAL_PROTOCOLS = new Set(["https:", "http:", "mailto:"]);

export function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    return ALLOWED_EXTERNAL_PROTOCOLS.has(new URL(rawUrl).protocol);
  } catch {
    return false;
  }
}

export async function openExternalUrl(rawUrl: string): Promise<void> {
  if (!isAllowedExternalUrl(rawUrl)) throw new Error("External URL is not allowed");
  await shell.openExternal(rawUrl);
}
