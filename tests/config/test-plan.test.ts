import { describe, expect, it } from "vitest";
// @ts-expect-error The directly executed .mjs helper intentionally has no declaration file.
import { planTests, readsRepository } from "../../scripts/test-plan.mjs";

const repositoryReaders = ["tests/config/launcher-runtime.test.ts", "tests/main/core/json-store.test.ts"];

function plan(changed: string[]) {
  return planTests({ changed, full: false, repositoryReaders });
}

describe("the default test plan", () => {
  it("runs nothing when nothing differs from HEAD or only documentation changed", () => {
    expect(plan([])).toEqual({ typecheck: false, vitest: null, live: false });
    expect(plan(["README.md", "CHANGELOG.md"])).toEqual({ typecheck: false, vitest: null, live: false });
  });

  it("typechecks and runs related tests for a TypeScript change", () => {
    expect(plan(["src/main/core/audio-tools.ts"])).toEqual({
      typecheck: true,
      vitest: ["src/main/core/audio-tools.ts"],
      live: false,
    });
  });

  it("adds every repository-reading test when a file outside the module graph changes", () => {
    expect(plan(["src/renderer/src/styles.css"])).toEqual({
      typecheck: false,
      vitest: ["src/renderer/src/styles.css", ...repositoryReaders],
      live: false,
    });
  });

  it("typechecks a live test but never runs the live lane", () => {
    expect(plan(["tests/live/main/core/app-runtime.test.ts"])).toMatchObject({ typecheck: true, live: false });
  });

  it("typechecks when the TypeScript configuration or dependencies change", () => {
    expect(plan(["tsconfig.web.json"]).typecheck).toBe(true);
    expect(plan(["package-lock.json"]).typecheck).toBe(true);
  });
});

describe("the full run plan", () => {
  it("typechecks, runs every test, and runs the live lane regardless of changes", () => {
    expect(planTests({ changed: [], full: true, repositoryReaders })).toEqual({
      typecheck: true,
      vitest: "all",
      live: true,
    });
  });
});

describe("repository readers", () => {
  it("are the tests that read files through Node", () => {
    expect(readsRepository('import { readFileSync } from "node:fs";')).toBe(true);
    expect(readsRepository('import { rm } from "node:fs/promises";')).toBe(true);
    expect(readsRepository("import { readFileSync } from 'node:fs';")).toBe(true);
    expect(readsRepository('import { existsSync } from "fs";')).toBe(true);
    expect(readsRepository('const fs = await import("node:fs");')).toBe(true);
    expect(readsRepository('import path from "node:path";')).toBe(false);
    expect(readsRepository('import { fsync } from "./fsync";')).toBe(false);
  });
});
