# Mumbler

Desktop audio transcription app built with Electron, React, and TypeScript.

## Scripts

- `npm run dev` — start the development app
- `npm run build` — build production bundles
- `npm run typecheck` — run the TypeScript checker

## Phase 1 Scope

The current implementation provides:

- Electron main, preload, and renderer process structure
- Typed preload bridge for shell bootstrap data
- A semantic two-pane UI shell matching the product spec
- No import, trim, ffmpeg, persistence, or Gemini behavior yet

