import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";

// electron-vite gives every main-process bundle its own __dirname and
// __filename, so a module that declares either makes the bundle a syntax error
// at load: the app fails to start while its tests, which never load the
// bundle, still pass. Modules use import.meta.dirname instead.
const SHIMMED = new Set(["__dirname", "__filename"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|mts)$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [full] : [];
  });
}

function declaredShims(file: string): string[] {
  const ast = parse(readFileSync(file, "utf8"), { sourceType: "module", plugins: ["typescript", "jsx"] });
  const found: string[] = [];
  for (const statement of ast.program.body) {
    const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations) {
        if (declarator.id.type === "Identifier" && SHIMMED.has(declarator.id.name)) found.push(declarator.id.name);
      }
    }
    if (declaration?.type === "FunctionDeclaration" && declaration.id && SHIMMED.has(declaration.id.name)) found.push(declaration.id.name);
  }
  return found;
}

describe("main-process modules and electron-vite's shims", () => {
  it("declare no __dirname or __filename of their own", () => {
    const roots = ["src/main", "src/shared"].map((dir) => join(process.cwd(), dir));
    const offenders = roots.flatMap((root) => sourceFiles(root).flatMap((file) =>
      declaredShims(file).map((name) => `${relative(process.cwd(), file)}: ${name}`)));
    expect(offenders).toEqual([]);
  });

  it("finds such a declaration", () => {
    const probe = join(process.cwd(), "node_modules", ".cache", "esm-shim-probe.ts");
    mkdirSync(dirname(probe), { recursive: true });
    writeFileSync(probe, 'const __dirname = "x";\nexport const value = __dirname;\n');
    try {
      expect(declaredShims(probe)).toEqual(["__dirname"]);
    } finally {
      rmSync(probe, { force: true });
    }
  });
});
