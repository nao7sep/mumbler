import { BrowserWindow, screen } from "electron";
import type { Rectangle } from "electron";

const MINIMUM_VISIBLE_EDGE = 128;

export function hasUsableWindowBounds(
  bounds: Rectangle,
  workAreas: readonly Rectangle[],
): boolean {
  if (bounds.width <= 0 || bounds.height <= 0) return false;

  return workAreas.some((area) => {
    if (area.width <= 0 || area.height <= 0) return false;
    const visibleWidth = Math.max(
      0,
      Math.min(bounds.x + bounds.width, area.x + area.width) -
        Math.max(bounds.x, area.x),
    );
    const visibleHeight = Math.max(
      0,
      Math.min(bounds.y + bounds.height, area.y + area.height) -
        Math.max(bounds.y, area.y),
    );
    return (
      visibleWidth >= Math.min(MINIMUM_VISIBLE_EDGE, bounds.width, area.width) &&
      visibleHeight >= Math.min(MINIMUM_VISIBLE_EDGE, bounds.height, area.height)
    );
  });
}

export function createWindowWithUsablePersistedBounds(
  name: string,
  create: () => BrowserWindow,
): BrowserWindow {
  const window = create();
  const workAreas = screen.getAllDisplays().map((display) => display.workArea);
  if (hasUsableWindowBounds(window.getBounds(), workAreas)) return window;

  // The first window is still hidden, so replacing it cannot flash. Clearing
  // Electron's state before recreating lets the existing constructor options
  // and the OS own the fallback placement.
  window.destroy();
  BrowserWindow.clearPersistedState(name);
  return create();
}
