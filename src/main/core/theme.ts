import { BrowserWindow, nativeTheme } from "electron";
import type { ThemePreference } from "@shared/app-shell";

// Electron's nativeTheme.themeSource is Mumbler's one theme authority
// (app-chrome conventions, Theme): it paints the native title bar, menus, and
// dialogs, and it decides `prefers-color-scheme` in every renderer, which is
// what styles.css's dark block and the startup failure dialog follow. No
// renderer resolves System itself.

// styles.css's --bg in each theme, so the frames before a page paints and the
// backing exposed while resizing already match it.
const LIGHT_BACKGROUND = "#edf4ec";
const DARK_BACKGROUND = "#111814";

export function windowBackground(dark: boolean): string {
  return dark ? DARK_BACKGROUND : LIGHT_BACKGROUND;
}

function syncWindowBackgrounds(): void {
  const color = windowBackground(nativeTheme.shouldUseDarkColors);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.setBackgroundColor(color);
  }
}

// The OS appearance, which the System entry names. Electron reports it only
// while themeSource is System (a Light or Dark choice overrides what it says),
// so it is read then and kept: at launch before the saved choice applies, and
// on each change under System. An OS change made while Light or Dark is chosen
// shows once System is chosen again; until then the label names the last
// appearance seen, a cosmetic lag accepted rather than read from each platform.
let systemTheme: "light" | "dark" | null = null;

function noteSystemTheme(): void {
  if (nativeTheme.themeSource === "system") systemTheme = nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

/** What System resolves to now, as far as the app has seen. */
export function currentSystemTheme(): "light" | "dark" {
  return systemTheme ?? "light";
}

/** Applies a saved choice to the whole app; System follows the OS. */
export function applyThemePreference(preference: ThemePreference): void {
  noteSystemTheme();
  nativeTheme.themeSource = preference;
  noteSystemTheme();
  syncWindowBackgrounds();
}

/** Keeps window backgrounds in step when the OS appearance changes under System. */
export function followOsThemeChanges(): void {
  nativeTheme.on("updated", () => {
    noteSystemTheme();
    syncWindowBackgrounds();
  });
}
