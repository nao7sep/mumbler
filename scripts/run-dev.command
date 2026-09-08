#!/usr/bin/env bash
set -euo pipefail

# run-dev: run the app from source with live reload, in its loosest configuration.
# For active coding and debugging. The strict, production-faithful launchers are
# run-built (launch the existing packaged app bundle without rebuilding) and
# rebuild (build and package a fresh bundle, then launch).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME_HELPER="$SCRIPT_DIR/launcher-runtime.mjs"
RUNTIME_TOKEN="run-dev-$$-$(date +%s)-$RANDOM"
RENDERER_URL="http://127.0.0.1:27259"

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
    echo "mumbler run-dev failed with exit code $status."
    read -r -p "Press Enter to close..."
  fi
}

cleanup() {
  local status="$?"
  trap - EXIT
  if node "$RUNTIME_HELPER" is-owner "$RUNTIME_TOKEN" >/dev/null 2>&1; then
    node "$RUNTIME_HELPER" stop-if-owner "$RUNTIME_TOKEN" electron "Mumbler" "Mumbler" >/dev/null 2>&1 || true
  else
    status=0
  fi
  pause_on_failure "$status"
  exit "$status"
}

trap cleanup EXIT

require_command node
require_command npm

cd "$REPO_DIR"

log_step "Replacing any existing Mumbler runtime"
node "$RUNTIME_HELPER" claim "$RUNTIME_TOKEN"
node "$RUNTIME_HELPER" stop electron "Mumbler" "Mumbler"
node "$RUNTIME_HELPER" check-endpoint 127.0.0.1 27259

log_step "Installing dependencies"
npm install

# npm install skips the Electron binary if the package is already at the locked version.
log_step "Verifying Electron binary"
if [[ ! -f node_modules/electron/path.txt ]]; then
  echo "Electron binary missing; downloading..."
  node node_modules/electron/install.js
fi

log_step "Starting Mumbler in development mode"
npm run dev &
DEV_PID=$!
node "$RUNTIME_HELPER" wait-http "$RENDERER_URL" 60000
node "$RUNTIME_HELPER" wait-process "$REPO_DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" 60000
log_step "Mumbler is ready at $RENDERER_URL"
wait "$DEV_PID"
