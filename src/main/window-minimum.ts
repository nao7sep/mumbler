import { screen, type BrowserWindow } from "electron";

type Size = { width: number; height: number };

/** Layout owns the content floor; only the native constraint is capped to the screen. */
export function fitNativeMinimum(required: Size, workArea: Size, frame: Size = { width: 0, height: 0 }): Size {
  return {
    width: Math.min(required.width + frame.width, workArea.width),
    height: Math.min(required.height + frame.height, workArea.height),
  };
}

/** Prepare the new hidden window before placement restoration; later refreshes never recenter it. */
export function configureWindowMinimum(
  win: BrowserWindow,
  required: () => Size,
  onError: (error: unknown) => void,
): () => void {
  const refresh = (): void => {
    if (win.isDestroyed() || win.isMaximized() || win.isMinimized() || win.isFullScreen()) return;
    try {
      const area = screen.getDisplayMatching(win.getBounds()).workAreaSize;
      const outer = win.getBounds();
      const client = win.getContentBounds();
      const minimum = fitNativeMinimum(required(), area, {
        width: Math.max(0, outer.width - client.width),
        height: Math.max(0, outer.height - client.height),
      });
      const [oldMinWidth, oldMinHeight] = win.getMinimumSize();
      if (oldMinWidth !== minimum.width || oldMinHeight !== minimum.height) {
        win.setMinimumSize(minimum.width, minimum.height);
      }
      // macOS does not grow an existing undersized window when its minimum changes.
      const [width, height] = win.getSize();
      if (width < minimum.width || height < minimum.height) {
        win.setSize(Math.max(width, minimum.width), Math.max(height, minimum.height));
      }
    } catch (error) { onError(error); }
  };
  const update = (): void => refresh();
  refresh();
  try {
    const area = screen.getDisplayMatching(win.getBounds()).workAreaSize;
    const [width, height] = win.getSize();
    if (width > area.width || height > area.height) {
      win.setSize(Math.min(width, area.width), Math.min(height, area.height));
    }
    win.center();
  } catch (error) { onError(error); }
  win.on("move", update);
  win.on("unmaximize", update);
  win.on("restore", update);
  win.on("leave-full-screen", update);
  screen.on("display-metrics-changed", update);
  win.once("closed", () => {
    win.off("move", update);
    win.off("unmaximize", update);
    win.off("restore", update);
    win.off("leave-full-screen", update);
    screen.off("display-metrics-changed", update);
  });
  return update;
}
