// Decides which checks a change needs. `npm run check` passes the paths that
// differ from HEAD; `npm run check:full` asks for everything. Kept pure so the
// selection rules are tested directly; scripts/check.mjs gathers the inputs
// and runs the lanes.

const TYPESCRIPT = /\.(ts|tsx)$/;
const TYPESCRIPT_CONFIG = /^(tsconfig[^/]*\.json|package(-lock)?\.json)$/;

/** Markdown is documentation: no test or build reads it. */
function isDocumentation(path) {
  return path.endsWith(".md");
}

function unique(values) {
  return [...new Set(values)];
}

/**
 * A test that reads files through Node instead of importing them. Import-based
 * selection cannot see what such a test depends on, so any change to a file
 * outside the TypeScript module graph runs every one of them.
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
export function planChecks({ changed, full, repositoryReaders }) {
  if (full) return { typecheck: true, vitest: "all" };

  const code = changed.filter((path) => !isDocumentation(path));
  const outsideModuleGraph = code.some((path) => !TYPESCRIPT.test(path));
  const related = unique([...code, ...(outsideModuleGraph ? repositoryReaders : [])]);
  return {
    typecheck: code.some((path) => TYPESCRIPT.test(path) || TYPESCRIPT_CONFIG.test(path)),
    vitest: related.length > 0 ? related : null,
  };
}
