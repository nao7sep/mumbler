import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  clearPersistedState: vi.fn(),
  workAreas: [{ x: 0, y: 0, width: 2560, height: 1392 }],
}));

vi.mock("electron", () => ({
  BrowserWindow: { clearPersistedState: electron.clearPersistedState },
  screen: {
    getAllDisplays: () =>
      electron.workAreas.map((workArea) => ({ workArea })),
  },
}));

import {
  createWindowWithUsablePersistedBounds,
  hasUsableWindowBounds,
} from "../../src/main/window-state-recovery";

describe("persisted window recovery", () => {
  beforeEach(() => {
    electron.clearPersistedState.mockReset();
    electron.workAreas = [{ x: 0, y: 0, width: 2560, height: 1392 }];
  });

  it("accepts ordinary and multi-display bounds", () => {
    expect(
      hasUsableWindowBounds(
        { x: 200, y: 100, width: 1200, height: 800 },
        electron.workAreas,
      ),
    ).toBe(true);
    expect(
      hasUsableWindowBounds(
        { x: -1100, y: 40, width: 1000, height: 700 },
        [
          { x: -1440, y: 0, width: 1440, height: 900 },
          ...electron.workAreas,
        ],
      ),
    ).toBe(true);
  });

  it("rejects a window with less than 128 pixels exposed on either edge", () => {
    expect(
      hasUsableWindowBounds(
        { x: 2460, y: 1292, width: 1200, height: 800 },
        electron.workAreas,
      ),
    ).toBe(false);
    expect(
      hasUsableWindowBounds(
        { x: 2432, y: 1264, width: 1200, height: 800 },
        electron.workAreas,
      ),
    ).toBe(true);
  });

  it("recreates a hidden window whose normal bounds are unusable", () => {
    const invalid = {
      // A maximized window's current bounds can be usable while Restore would
      // return it to an unusable normal rectangle.
      getBounds: () => ({ x: 0, y: 0, width: 2560, height: 1392 }),
      getNormalBounds: () => ({ x: 2460, y: 1292, width: 1200, height: 800 }),
      destroy: vi.fn(),
    };
    const fallback = {
      getBounds: () => ({ x: 200, y: 100, width: 1200, height: 800 }),
      getNormalBounds: () => ({ x: 200, y: 100, width: 1200, height: 800 }),
      destroy: vi.fn(),
    };
    const create = vi
      .fn()
      .mockReturnValueOnce(invalid)
      .mockReturnValueOnce(fallback);

    expect(createWindowWithUsablePersistedBounds("main", create as never)).toBe(
      fallback,
    );
    expect(invalid.destroy).toHaveBeenCalledOnce();
    expect(electron.clearPersistedState).toHaveBeenCalledWith("main");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("leaves usable restored state entirely under Electron's ownership", () => {
    const restored = {
      getBounds: () => ({ x: 200, y: 100, width: 1200, height: 800 }),
      getNormalBounds: () => ({ x: 200, y: 100, width: 1200, height: 800 }),
      destroy: vi.fn(),
    };
    const create = vi.fn(() => restored);

    expect(createWindowWithUsablePersistedBounds("main", create as never)).toBe(
      restored,
    );
    expect(restored.destroy).not.toHaveBeenCalled();
    expect(electron.clearPersistedState).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
  });
});
