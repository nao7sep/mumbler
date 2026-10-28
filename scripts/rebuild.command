#!/usr/bin/env bash
set -euo pipefail

# rebuild: produce a fresh production build, package it into a real .app bundle,
# and launch that bundle. Slow — run this after changing source. The build runs
# the production type checks and re-bundles from clean, so type, import, CSP, and
# packaged-layout errors that run-dev hides surface here; packaging then gives the
# app its own bundle identity (correct dock/menu name). run-built is the fast,
# no-build launcher for everything after this.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_NAME="Mumbler"
RUNTIME_HELPER="$SCRIPT_DIR/launcher-runtime.mjs"
OUT_DIR="dist"

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
  if [[ "$status" -ne 0 && ( "$status" -lt 128 || "$status" -gt 143 ) ]]; then
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
npm install --no-audit --no-fund

# npm install skips the Electron binary if the package is already at the locked version.
log_step "Verifying Electron binary"
if [[ ! -f node_modules/electron/path.txt ]]; then
  echo "Electron binary missing; downloading..."
  node node_modules/electron/install.js
fi

# Build into a clean candidate so a build that fails to emit a file can't be masked
# by a leftover artifact; the previous package stays runnable until the candidate
# is complete.
log_step "Preparing clean build output"
CANDIDATE="$(node "$RUNTIME_HELPER" prepare-candidate)"

# The release build type-checks the shipped sources (main/preload + renderer);
# the dev server skips this entirely. Tests are checked separately and are not
# part of the release build, so they are not gated here.
log_step "Type-checking production sources (node + web)"
node_modules/.bin/tsc --noEmit -p tsconfig.node.json
node_modules/.bin/tsc --noEmit -p tsconfig.web.json

log_step "Building production bundle"
node_modules/.bin/electron-vite build

# Package the built output into a real .app bundle — the .app only, no dmg/zip
# installer; electron-builder ad-hoc-signs on macOS by default. The bundle gives
# the app its own identity, so the dock and menu show "Mumbler" rather than the
# generic "Electron".
log_step "Packaging the app bundle"
node_modules/.bin/electron-builder --dir --config.directories.output="$CANDIDATE"

log_step "Publishing the verified package"
node "$RUNTIME_HELPER" stop
node "$RUNTIME_HELPER" publish-candidate

APP_BUNDLE="$(find "$OUT_DIR" -maxdepth 2 -name "$APP_NAME.app" -type d 2>/dev/null | head -1 || true)"
log_step "Launching the packaged app"
node "$RUNTIME_HELPER" launch-bundle "$APP_BUNDLE"
