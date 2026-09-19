// Decides which lanes a change needs. `npm test` passes the paths that
// differ from HEAD; `npm run test:full` asks for everything. Kept pure so the
// selection rules are tested directly; scripts/test.mjs gathers the inputs
// and runs the lanes.

// What the type check reads: modules, including the JSON they import, and its
// own configuration (tsconfig*.json, package.json and its lock file).
const TYPE_CHECKED = /\.(?:[cm]?[jt]s|[jt]sx|json)$/;

/** Markdown is documentation: no test or build reads it. */
function isDocumentation(path) {
  return path.endsWith(".md");
}

function unique(values) {
  return [...new Set(values)];
}

/**
 * A test that reads files through Node instead of importing them. Import-based
 * selection cannot see what such a test depends on, and many read source files
 * as text, so every change but documentation runs every one of them.
 */
export function readsRepository(testSource) {
  return /(?:from\s+|import\s*\(\s*)["'](?:node:)?(?:fs|child_process)(?:\/promises)?["']/.test(testSource);
}

/**
 * @param {object} input
 * @param {string[]} input.changed repository-relative, "/"-separated paths
 * @param {boolean} input.full
 * @param {string[]} input.repositoryReaders test files for which readsRepository holds
 */
export function planTests({ changed, full, repositoryReaders }) {
  // The live lane calls the real Gemini API and runs the real managed audio
  // tools, so only the full run runs it; the default still typechecks it.
  if (full) return { typecheck: true, vitest: "all", live: true };

  const code = changed.filter((path) => !isDocumentation(path));
  const related = unique([...code, ...(code.length > 0 ? repositoryReaders : [])]);
  return {
    typecheck: code.some((path) => TYPE_CHECKED.test(path)),
    vitest: related.length > 0 ? related : null,
    live: false,
  };
}
