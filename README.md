# Mumbler

A desktop app for generating transcription and metadata from audio recordings using Google Gemini AI. Import recordings, trim them, generate transcription, structured transcription, title, and slug metadata, then save audio with JSON and Markdown output files.

## Features

- **Waveform editor** — visualize audio with WaveSurfer.js; set front/back trim markers to cut unwanted silence before generation
- **AI pipeline** — sends audio to Google Gemini, then generates transcription, structured transcription, title, and URL slug as separate dependent steps
- **Queue** — import multiple files and process transcriptions concurrently (configurable limit); extra cards beyond the limit auto-queue and start as slots free
- **Cancellation and generation** — cancel stuck AI work or generate any step on demand; generating a step also regenerates the dependent downstream outputs it invalidates
- **Timestamp parsing** — extracts recording datetime from filenames using configurable regex patterns; falls back to file modification time
- **Atomic save** — writes audio + JSON + Markdown atomically (temp → rename) with rollback on failure
- **Optional source backup and deletion** — can copy the original to a backup folder and/or permanently delete it after confirming an import (backup is on by default)

## Requirements

- Node.js 20+
- A [Google Gemini API key](https://aistudio.google.com/app/apikey)

## Getting Started

```bash
git clone https://github.com/nao7sep/mumbler
cd mumbler
npm install
npm run dev
```

On first launch, open Settings and enter your Gemini API key. The output directory defaults to `~/.mumbler/output`; configure a custom location in Settings if desired.

## Usage

1. **Import** — drag audio files onto the window or use the import dialog
2. **Review** — the import review screen shows filename-parsed timestamps; adjust if needed and confirm. Originals are copied to the backup folder by default; you can also choose to permanently delete them from their source location.
3. **Trim** — drag the front/back markers on the waveform to cut unwanted sections
4. **Generate** — click Generate All; the app sends the (trimmed) audio to Gemini and runs transcription, structured transcription, title generation, and slug generation
5. **Repair if needed** — cancel stuck AI work or use Generate beside any field; generation automatically ensures prerequisites and regenerates dependent later steps when needed
6. **Save** — save the card to the output directory; produces timestamp-prefixed audio, JSON, and Markdown files

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `↑` / `↓` | Select previous / next card |
| `Space` | Play / pause |
| `[` | Set front trim marker at cursor |
| `]` | Set back trim marker at cursor |

## Settings

| Setting | Description |
|---------|-------------|
| Gemini API Key | API key for Google Gemini |
| Output Directory | Where saved files are written (default: `~/.mumbler/output`) |
| Backup Directory | Where originals are copied when "Copy originals to backup folder" is selected (default: `~/.mumbler/backups`) |
| Transcription Model | Gemini model used for transcription |
| Metadata Model | Gemini model used for structured transcription, title, and slug generation |
| Default Timezone | Timezone for recording timestamps |
| Timestamp Patterns | Regex patterns to parse datetime from filenames |
| Structured Prompt | Custom prompt for structured transcription generation |
| Title Prompt | Custom prompt for title generation |
| Slug Prompt | Custom prompt for slug generation |
| Preview Snippet | Seconds of audio sent for waveform preview |
| Concurrency Limit | Max audio transcription jobs processed simultaneously |
| Transcription Timeout | Timeout for each audio transcription request; the default is intentionally higher because Gemini docs support up to 9.5 hours of audio in one prompt |
| Text-only AI Timeout | Timeout for each structured transcription, title, or slug request |
| Retry Policy | Max retries, delay, and jitter for retryable Gemini/network failures |

## Output Format

Each saved card produces three files in the output directory:

**`<timestamp>-<slug>.<ext>`** — the audio file (original or trimmed; never re-encoded unless stream-copy trim is impossible)

**`<timestamp>-<slug>.json`** — metadata sidecar:

```json
{
  "schemaVersion": 1,
  "originalFilename": "...",
  "timestamps": {
    "confirmedLocal": "2026-04-22 09:44:00",
    "effectiveUtc": "..."
  },
  "transcription": {
    "raw": "...",
    "structured": "...",
    "title": "...",
    "slug": "..."
  }
}
```

**`<timestamp>-<slug>.md`** — Markdown export with YAML front matter and the structured transcription body.

## Data Directory

App data is stored in `~/.mumbler` by default. Override with the `MUMBLER_HOME` environment variable.

```
~/.mumbler/
  settings.json     # app settings
  state.json        # queue state
  working/          # working copies of imported audio
  output/           # default output folder for saved files (configurable)
  backups/          # default backup folder for originals (configurable)
  logs/             # application logs
```

## Tech Stack

- [Electron](https://www.electronjs.org/) + [electron-vite](https://electron-vite.org/)
- [React](https://react.dev/) + TypeScript
- [WaveSurfer.js](https://wavesurfer.xyz/) for waveform rendering
- [FFmpeg](https://ffmpeg.org/) (via `ffmpeg-static` / `ffprobe-static`) for audio trimming and probing
- [Google Gemini API](https://ai.google.dev/) (`@google/genai`) for transcription and metadata

## License

MIT
