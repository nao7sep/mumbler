// `npm test` runs only the lanes that the working-tree changes against
// HEAD can affect; `npm run test:full` runs every lane. test-plan.mjs owns
// the selection; this file gathers its inputs and runs the chosen lanes in
// order, stopping at the first failure.

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planTests, readsRepository } from "./test-plan.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function changedPaths() {
  const status = execFileSync(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { cwd: ROOT, encoding: "utf8" },
  );
  const entries = status.split("\0").filter(Boolean);
  const paths = [];
  for (let index = 0; index < entries.length; index += 1) {
    const state = entries[index].slice(0, 2);
    paths.push(entries[index].slice(3));
    // With -z, a rename or copy is followed by its source path.
    if (state[0] === "R" || state[0] === "C") paths.push(entries[(index += 1)]);
  }
  return paths;
}

function testFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return testFiles(absolute);
    return /\.test\.tsx?$/.test(entry.name) ? [absolute] : [];
  });
}

function repositoryPath(absolute) {
  return path.relative(ROOT, absolute).split(path.sep).join("/");
}

function run(label, command, args, shell = false) {
  process.stdout.write(`\n› ${label}\n`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit", shell });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const full = process.argv.includes("--full");
const changed = full ? [] : changedPaths();
const plan = planTests({
  changed,
  full,
  // tests/live never runs in the ordinary suite, so it never joins the readers.
  repositoryReaders: testFiles(path.join(ROOT, "tests"))
    .map(repositoryPath)
    .filter((file) => !file.startsWith("tests/live/"))
    .filter((file) => readsRepository(readFileSync(path.join(ROOT, file), "utf8"))),
});

if (!full) {
  process.stdout.write(
    changed.length === 0
      ? "Nothing differs from HEAD; no tests to run.\n"
      : `Testing what ${changed.length} changed path(s) against HEAD can affect.\n`,
  );
}

// npm is a .cmd shim on Windows, which Node starts only through a shell.
if (plan.typecheck) run("typecheck", "npm", ["run", "typecheck"], process.platform === "win32");
const vitest = path.join(ROOT, "node_modules", "vitest", "vitest.mjs");
if (plan.vitest === "all") {
  run("vitest", process.execPath, [vitest, "run"]);
} else if (plan.vitest) {
  run("vitest related", process.execPath, [vitest, "related", "--run", "--passWithNoTests", ...plan.vitest]);
}
if (plan.live) {
  run(
    "live lane: real Gemini calls (GEMINI_API_KEY, costs money) and the managed ffmpeg and ffprobe",
    process.execPath,
    [vitest, "run", "--config", "vitest.live.config.ts"],
  );
}
