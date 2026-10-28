import { describe, expect, it } from "vitest";

import config from "../../electron.vite.config";

// The development renderer keeps its registered port: a taken port fails
// instead of moving elsewhere.
describe("Electron development endpoint", () => {
  it("fails on a taken port instead of moving elsewhere", () => {
    expect(config.renderer?.server?.strictPort).toBe(true);
  });
});
