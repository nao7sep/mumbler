import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import config from "../../electron.vite.config";

// run-dev checks and waits on the dev server's address before Electron starts,
// so each launcher must name the host and port the build config serves on.
describe("Electron development endpoint", () => {
  it("is the address the run-dev launchers check and wait on", () => {
    const { host, port, strictPort } = config.renderer?.server ?? {};
    expect(strictPort, "a taken port fails instead of moving elsewhere").toBe(true);
    for (const launcher of ["run-dev.command", "run-dev.ps1"]) {
      const text = readFileSync(join(process.cwd(), "scripts", launcher), "utf8");
      const addresses = [...text.matchAll(/(\d{1,3}(?:\.\d{1,3}){3})["',\s:]+"?(\d{2,5})/g)].map((match) => `${match[1]}:${match[2]}`);
      expect(addresses.length, launcher).toBeGreaterThanOrEqual(2);
      for (const address of addresses) expect(address, launcher).toBe(`${host}:${port}`);
    }
  });
});
