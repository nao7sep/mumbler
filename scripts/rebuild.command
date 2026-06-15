#!/usr/bin/env bash
set -euo pipefail

# rebuild: produce a fresh PRODUCTION build (release configuration) and launch
# it. Slow — run this after changing source. The build runs the production type
# checks the release build runs and re-bundles from clean, so type, import, CSP,
# and packaged-layout errors that `run-dev` hides surface here. `run-built` is
# the fast, no-build launcher for everything after this.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

log_step() {
  printf '\n==> %s\n' "$1"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

pause_on_failure() {
  local status="$1"
  if [[ "$status" -ne 0 && "$status" -ne 130 ]]; then
    echo
    echo "mumbler rebuild failed with exit code $status."
    read -r -p "Press Enter to close..."
  fi
}

trap 'pause_on_failure $?' EXIT

require_command node
require_command npm

cd "$REPO_DIR"

log_step "Installing dependencies"
npm install

# npm install skips the Electron binary if the package is already at the locked version.
log_step "Verifying Electron binary"
if [[ ! -f node_modules/electron/path.txt ]]; then
  echo "Electron binary missing; downloading..."
  node node_modules/electron/install.js
fi

# Remove stale output so a build that fails to emit a file can't be masked by a
# leftover artifact from a previous run.
log_step "Cleaning previous production build"
rm -rf out

# The release build type-checks the shipped sources (main/preload + renderer);
# the dev server skips this entirely. Tests are checked separately and are not
# part of the release build, so they are not gated here.
log_step "Type-checking production sources (node + web)"
node_modules/.bin/tsc --noEmit -p tsconfig.node.json
node_modules/.bin/tsc --noEmit -p tsconfig.web.json

log_step "Building production bundle"
node_modules/.bin/electron-vite build

# preview runs the built main against the built renderer over file://, so the
# production Content-Security-Policy and packaged-layout paths are exercised as
# in a release.
log_step "Launching the production build"
node_modules/.bin/electron-vite preview
