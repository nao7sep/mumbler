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
- In-app settings modal for Gemini key, models, languages, timezone, prompts, retries, and timeouts
- Editable central shortcut registry with renderer-side keyboard handling
- App-wide main/renderer error surfacing with a custom blocking modal
- Timestamp-reviewed import flow from file picker or drag-and-drop
- Pending timestamp-review edits persisted back to state before final confirmation
- Destructive source handling: copy into working storage, then move outside source to trash
- Queue selection and persisted pending-review state
- Audio probing with `ffprobe-static` during queue entry
- Waveform playback with `wavesurfer.js`
- Front/back trim markers with drag, nudge, text input, and preview playback
- Duplicate-card flow for splitting one recording into multiple extracts
- Front-trim timestamp shifting and ffprobe-based trim decision analysis
- Gemini transcription pipeline via `@google/genai`
- Automatic title and slug generation after successful transcription
- Retry flow that resumes from the failed Gemini step when possible
- Per-card language override that clears stale results before retranscription
- Ready-to-save card states with per-artifact model provenance in app state
- Output-directory selection through the desktop shell
- Atomic audio plus JSON finalization with filename collision handling
- Remove workflow that trashes app-managed working audio after confirmation
- Copy-to-clipboard actions for transcript, title, and slug results
- Custom app-close confirmation instead of native browser or OS confirmation prompts
- Startup diagnostic recovery with a reset-state action

## Verification Gaps

- Full end-to-end operation still needs an interactive desktop UI run
- Trim behavior still needs verification against more real files and codecs
- External-drive import fallback and trash-staging behavior still need a live test
