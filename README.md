# Mumbler

Mumbler is a desktop app for turning audio recordings into transcripts and publishable metadata with Google Gemini. Import recordings, trim silence on a waveform, then generate a transcription, a structured transcription, a title, and a URL slug — saved together as audio plus JSON and Markdown sidecars. It's for podcasters, note-takers, and writers who want clean, structured text out of raw recordings. Built on Electron, React, and TypeScript; transcription runs through your own Gemini API key.

## Features

- **Waveform editor** — set front/back trim markers to cut silence before generation
- **AI pipeline** — transcription → structured transcription → title → slug, each a dependent step that regenerates downstream outputs when changed
- **Queue** — import many files and process them concurrently, with a configurable limit
- **Timestamp parsing** — pull the recording datetime from filenames via configurable regex, prompting when none matches
- **Atomic save** — writes audio + JSON + Markdown together, with rollback on failure
- **IME-safe** — Japanese/Chinese/Korean input works in every text field

## Requirements

- Node.js 20+
- A Google Gemini API key (the AI features call Gemini, billed to your key)
- macOS (Apple Silicon) or Windows (x64) — Electron desktop app
- **ffmpeg and ffprobe**, used to read and trim audio. Mumbler downloads them on first run as native builds (macOS arm64 from ffmpeg.martin-riedl.de, Windows x64 from BtbN), verifies each against the vendor's published SHA-256, and keeps them in `~/.mumbler/bin`. Manage them — install, update, reinstall — from the **Audio Tools** menu. An internet connection is needed for that first download. On Linux, install ffmpeg/ffprobe yourself and put them on `PATH`.

## Getting started

Double-click the launcher for your platform (`scripts/run-dev.command` on macOS, `scripts/run-dev.ps1` on Windows), or run from source:

```bash
npm install
npm run dev
```

On first launch, open Settings and enter your Gemini API key. Saved files default to `~/.mumbler/output`.

## License

MIT © 2026 Yoshinao Inoguchi

## Contact

Yoshinao Inoguchi — nao7sep@gmail.com
