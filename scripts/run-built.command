#!/usr/bin/env bash
set -euo pipefail

# run-built: launch the EXISTING packaged app without rebuilding, so it starts
# instantly. This is the daily-use launcher and the one that surfaces
# production-only failures (strict CSP, file:// paths, packaged layout) and runs
# under the app's own bundle identity. It never builds — if you changed source,
# run rebuild first.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_NAME="Mumbler"
OUT_DIR="dist"

log_step() {
  printf '\n==> %s\n' "$1"
}

pause_on_failure() {
  local status="$1"
  if [[ "$status" -ne 0 && "$status" -ne 130 ]]; then
    echo
    echo "mumbler run-built failed with exit code $status."
    read -r -p "Press Enter to close..."
  fi
}

trap 'pause_on_failure $?' EXIT

cd "$REPO_DIR"

# No build here: this launcher must start instantly. If there is no usable bundle
# yet, stop and point at rebuild rather than launching something stale or empty.
APP_BUNDLE="$(find "$OUT_DIR" -maxdepth 2 -name "$APP_NAME.app" -type d 2>/dev/null | head -1 || true)"
if [[ -z "$APP_BUNDLE" || ! -d "$APP_BUNDLE/Contents/MacOS" ]]; then
  echo "No packaged app found ($OUT_DIR/mac*/$APP_NAME.app is missing) — run rebuild first."
  exit 1
fi

# Age tracks the actual build: packaging resets Contents/MacOS, but the .app dir's
# own mtime can lag — stat the executable dir, not the bundle root.
built_at="$(stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S %Z' "$APP_BUNDLE/Contents/MacOS" 2>/dev/null || echo 'unknown')"
log_step "Launching the existing packaged app (built: $built_at)"
echo "If you changed source since then, run rebuild instead."

open "$APP_BUNDLE"
