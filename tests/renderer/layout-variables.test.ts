// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { applyLayoutVariables } from "@renderer/layout-variables";

const RENDERER = resolve("src/renderer/src");
const css = readFileSync(join(RENDERER, "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Every custom property a stylesheet reads but nothing defines. */
function undefinedVariables(stylesheet: string, definedElsewhere: ReadonlySet<string>): string[] {
  const defined = new Set([...stylesheet.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]!));
  const read = new Set([...stylesheet.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]!));
  return [...read].filter((name) => !defined.has(name) && !definedElsewhere.has(name)).sort();
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sourceFiles(join(directory, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(directory, entry.name)] : []);
}

describe("the stylesheet's pane lengths", () => {
  it("reads only variables the stylesheet, the layout constants or an inline style define", () => {
    const root = document.createElement("div");
    applyLayoutVariables(root);
    const fromLayout = [...root.style].filter((name) => name.startsWith("--"));
    // Set inline from the live, dragged width (App.tsx, RecordsWindow.tsx).
    const inline = sourceFiles(RENDERER).flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/"(--[\w-]+)":/g)].map((match) => match[1]!));
    expect(undefinedVariables(css, new Set([...fromLayout, ...inline]))).toEqual([]);
    expect(fromLayout.length, "the layout lengths reach the root").toBeGreaterThan(0);
  });

  it("would catch a variable nothing defines", () => {
    expect(undefinedVariables(".x { gap: var(--nowhere); }", new Set())).toEqual(["--nowhere"]);
  });

  it("sets every length in pixels", () => {
    const root = document.createElement("div");
    applyLayoutVariables(root);
    for (const name of root.style) expect(root.style.getPropertyValue(name), name).toMatch(/^\d+px$/);
  });
});
