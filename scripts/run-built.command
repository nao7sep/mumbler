#!/usr/bin/env bash
set -euo pipefail

# run-built: launch the EXISTING production build without rebuilding, so it
# starts instantly. This is the daily-use launcher and the one that surfaces
# production-only failures (strict CSP, file:// paths, packaged layout). It
# never builds — if you changed source, run rebuild first.

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
    echo "mumbler run-built failed with exit code $status."
    read -r -p "Press Enter to close..."
  fi
}

trap 'pause_on_failure $?' EXIT

require_command node

cd "$REPO_DIR"

# No build, no dependency install here: this launcher must start instantly. If
# there is no usable build yet, stop and point at rebuild rather than launching
# something stale or empty.
if [[ ! -f out/renderer/index.html || ! -d out/main || ! -x node_modules/.bin/electron-vite ]]; then
  echo "No production build found (out/ is missing or incomplete, or dependencies are not installed)."
  echo "Run rebuild first to produce one."
  exit 1
fi

built_at="$(stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S %Z' out/renderer/index.html 2>/dev/null || echo 'unknown')"
log_step "Launching the existing production build (built: $built_at)"
echo "If you changed source since then, run rebuild instead."

node_modules/.bin/electron-vite preview
