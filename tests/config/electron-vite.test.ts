import { describe, expect, it } from "vitest";

import config from "../../electron.vite.config";

describe("Electron development endpoint", () => {
  it("owns a stable strict loopback port", () => {
    expect(config.renderer?.server).toMatchObject({ host: "127.0.0.1", port: 27259, strictPort: true });
  });
});
