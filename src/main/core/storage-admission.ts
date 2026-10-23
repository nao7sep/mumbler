import { chmod, mkdir, readdir, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { AppPaths } from "@shared/app-shell";

export interface StorageAdmission { paths: AppPaths; firstRun: boolean }

/** Runs before stores or framework profile creation, after instance admission. */
export async function admitStorageRoot(paths: AppPaths): Promise<StorageAdmission> {
  await mkdir(paths.homeDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    const info = await stat(paths.homeDir);
    if ((info.mode & 0o077) !== 0) await chmod(paths.homeDir, 0o700);
    const secured = await stat(paths.homeDir);
    if ((secured.mode & 0o077) !== 0) throw new Error("Storage root is not owner-only.");
  }
  // Framework-only residue from an interrupted first launch is not app work.
  const firstRun = (await readdir(paths.homeDir)).every((name) => name === basename(paths.profileDir));
  return { paths, firstRun };
}

export async function prepareFrameworkStorage(admission: StorageAdmission, app: {
  setPath(name: "userData" | "sessionData", path: string): void;
}): Promise<void> {
  await mkdir(admission.paths.profileDir, { recursive: true, mode: 0o700 });
  app.setPath("userData", admission.paths.profileDir);
  app.setPath("sessionData", admission.paths.profileDir);
}
