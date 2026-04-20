#!/usr/bin/env bash
set -euo pipefail

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
    echo "mumbler update-packages failed with exit code $status."
    read -r -p "Press Enter to close..."
  fi
}

trap 'pause_on_failure $?' EXIT

require_command node
require_command npm

cd "$REPO_DIR"

log_step "Installing current dependencies"
npm install

log_step "Updating npm packages within declared ranges"
npm update

log_step "Cleaning previous build outputs"
rm -rf "$REPO_DIR/out" "$REPO_DIR/dist"

log_step "Building the desktop app"
npm run build
