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

/** Applies a saved choice to the whole app; System follows the OS. */
export function applyThemePreference(preference: ThemePreference): void {
  nativeTheme.themeSource = preference;
  syncWindowBackgrounds();
}

/** Keeps window backgrounds in step when the OS appearance changes under System. */
export function followOsThemeChanges(): void {
  nativeTheme.on("updated", syncWindowBackgrounds);
}
