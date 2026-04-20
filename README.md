# Mumbler

Desktop audio transcription app built with Electron, React, and TypeScript.

## Scripts

- `npm run dev` — start the development app
- `npm run build` — build production bundles
- `npm run typecheck` — run the TypeScript checker

## Current Scope

The current implementation provides:

- Electron main, preload, and renderer process structure
- Typed preload bridge and IPC-backed app snapshot
- `~/.mumbler` bootstrap for settings, state, logs, and working storage
- Timestamp-reviewed import flow from file picker or drag-and-drop
- Destructive source handling: copy into working storage, then move outside source to trash
- Queue selection and persisted pending-review state
- No trim, ffmpeg, audio playback, or Gemini behavior yet
