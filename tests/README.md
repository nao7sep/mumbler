# Mumbler's areas, and the tests that stand for them

`npm test` is the type check plus this whole suite, minus `live/`: at a few seconds it is already a
fixed, balanced run, so nothing selects a subset of it. `npm run test:full` adds `live/`, which takes
real audio through the real Gemini API on the real application runtime.

This file is the balance judgement the `tests-folder-conventions` require — which areas Mumbler has,
and which tests stand for each — so a reader can tell what a green run covered, and an area with no
test standing for it is visible rather than merely absent. `tests/area-map.test.ts` holds every path
below to what is on disk.

Paths are relative to this folder.

| Area | What it covers | Tests standing for it |
|---|---|---|
| Audio import and probing | Accepting a recording, reading what it is, and the rules for admitting it | `shared/audio-import.test.ts`, `main/core/audio-probe.test.ts`, `renderer/app/import-rules.test.ts`, `renderer/app/useImportFlow.test.ts` |
| The trimming editor | The waveform, its markers, and the palette it draws with | `renderer/app/WaveformEditor.test.tsx`, `renderer/app/waveform-palette.test.ts`, `renderer/app/AudioToolsModal.test.ts`, `shared/timestamps.test.ts`, `renderer/app/TimestampReviewModal.test.tsx` |
| Transcription and metadata | The Gemini calls behind a transcription, an outline, a title, and a slug | `main/core/gemini-adapter.test.ts`, `main/core/gemini-adapter.transport.test.ts`, `main/core/gemini-refusal.test.ts`, `main/core/card-pipeline.test.ts`, `main/core/card-pipeline.run.test.ts`, `main/core/pipeline-coordinator.test.ts`, `main/core/transcription-queue.test.ts`, `main/core/text-cleanup.test.ts`, `renderer/app/generate-rules.test.ts` |
| Saving the result | The audio, its JSON and Markdown sidecars, and the working files behind them | `main/core/file-output.test.ts`, `main/core/file-output.restore.test.ts`, `main/core/file-io.test.ts`, `main/core/working-files.test.ts`, `main/core/json-store.test.ts` |
| Managed binaries | Acquiring ffmpeg and ffprobe, and proving what was acquired | `main/core/binaries/manager.test.ts`, `main/core/binaries/registry.test.ts`, `main/core/binaries/store.test.ts`, `main/core/binaries/integrity.test.ts`, `main/core/binaries/archive.test.ts`, `main/core/binaries/http.test.ts`, `main/core/binaries/arch.test.ts`, `main/core/binaries/installed-version.test.ts`, `shared/dependency-status.test.ts`, `main/core/audio-tools.test.ts`, `main/core/audio-tools-bounded.test.ts` |
| Cards and the queue | A recording's card, its status, and the list the app works through | `main/core/app-runtime.cards.test.ts`, `renderer/app/card-status.test.ts`, `renderer/app/CardActionResults.test.ts`, `renderer/app/QueueList.test.ts` |
| The application runtime and its IPC | What the main process exposes, and the calls the window makes | `main/core/app-runtime.test.ts`, `main/ipc/app-shell.test.ts`, `main/index.test.ts`, `main/external-url.test.ts` |
| Settings and keys | Saved settings, their schema and validation, their backups, and where keys come from | `main/core/settings-store.test.ts`, `main/core/settings-schema.test.ts`, `shared/settings-validation.test.ts`, `main/core/backupStore.test.ts`, `main/core/api-keys.test.ts`, `renderer/app/SettingsModal.test.ts` |
| Window, theme, and styling | Window bounds and minimums, light and dark, and the stylesheet | `main/window.test.ts`, `main/window-minimum.test.ts`, `main/window-state-recovery.test.ts`, `main/core/theme.test.ts`, `main/core/layout-store.test.ts`, `shared/layout.test.ts`, `renderer/themeContrast.test.ts`, `renderer/styles.test.ts` |
| Renderer interaction | Modals, menus, keyboard navigation, drops, and what a failure looks like | `renderer/app/modal/ModalShell.test.ts`, `renderer/app/modal/modalStack.test.ts`, `renderer/app/modal/focusTrap.test.ts`, `renderer/app/DecisionModals.test.ts`, `renderer/app/Menu.test.ts`, `renderer/app/composite-nav.test.ts`, `renderer/app/shortcut-utils.test.ts`, `renderer/app/external-drop-boundary.test.ts`, `renderer/app/Notifications.test.ts`, `renderer/app/InlineResult.test.ts`, `renderer/app/AboutModal.test.tsx` |
| Startup and failure | Opening the app, and what it shows when it cannot | `renderer/app/App.startup.test.tsx`, `main/startup-failure-dialog.test.ts`, `renderer/app/RendererErrorBoundary.test.tsx`, `renderer/app/presentFailure.test.ts` |
| Logging | The session log and what it records | `main/core/logger.test.ts` |
| Packaging and launchers | What ships, how it is built, and the double-clickable launchers | `config/electron-vite.test.ts`, `config/launcher-runtime.test.ts`, `main/installer-config.test.ts` |
