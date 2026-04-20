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
- Audio probing with `ffprobe-static` during queue entry
- Waveform playback with `wavesurfer.js`
- Front/back trim markers with drag, nudge, text input, and preview playback
- Duplicate-card flow for splitting one recording into multiple extracts
- Front-trim timestamp shifting and ffprobe-based trim decision analysis
- No Gemini transcription, metadata generation, or final save workflow yet

## Verification Gaps

- Destructive import and trash behavior still need an interactive desktop run
- Trim-boundary decisions still need verification against real audio files
- Gemini API integration still needs a real API key in a later phase
