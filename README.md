# Mumbler

A desktop app for generating transcription and metadata from audio recordings using Google Gemini AI. Import recordings, trim them, generate transcription, structured transcription, title, and slug metadata, then save audio with JSON and Markdown output files.

## Features

- **Waveform editor** — visualize audio with WaveSurfer.js; set front/back trim markers to cut unwanted silence before generation
- **AI pipeline** — sends audio to Google Gemini, then generates transcription, structured transcription, title, and URL slug as separate dependent steps
- **Queue** — import multiple files and process transcriptions concurrently (configurable limit); extra cards beyond the limit auto-queue and start as slots free
- **Cancellation and generation** — cancel stuck AI work or generate any step on demand; generating a step also regenerates the dependent downstream outputs it invalidates
- **Timestamp parsing** — extracts recording datetime from filenames using configurable regex patterns; falls back to file modification time
- **IME composition support** — Japanese/Chinese/Korean input works correctly in all text fields
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

The built-in Gemini model list currently offers **Gemini 3.1 Pro (Preview)**, **Gemini 3.5 Flash**, **Gemini 3 Flash (Preview)**, and **Gemini 3.1 Flash Lite**.

## Testing

```bash
npm test           # run the unit and integration suite once
npm run test:watch # re-run on change during development
npm run typecheck  # type-check the project without emitting
```

Tests run under [Vitest](https://vitest.dev/) and live under `tests/`, mirroring the `src/` tree.

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
| `Up` / `Down` | Select previous / next card |
| `Space` | Play / pause |
| `Left` / `Right` | Skip backward / forward (configurable interval) |
| `Left Bracket` | Play first N seconds |
| `Right Bracket` | Play last N seconds |
| `F` | Set front trim marker at cursor |
| `B` | Set back trim marker at cursor |
| `T` | Generate All |
| `S` | Save |

## Settings

| Setting | Description |
|---------|-------------|
| Output Directory | Where saved files are written (default: `~/.mumbler/output`) |
| Backup Directory | Where originals are copied when "Copy originals to backup folder" is selected (default: `~/.mumbler/backups`) |
| Default Timezone | Timezone for recording timestamps |
| Timestamp Patterns | Regex patterns to parse datetime from filenames |
| Skip Interval | Seconds jumped by the Left / Right keys |
| Preview Duration | Seconds of audio played by the Play First / Play Last buttons |
| Gemini API Key | API key for Google Gemini |
| Transcription Model | Gemini model used for audio transcription and structured transcription |
| Metadata Model | Gemini model used for title and slug generation |
| Concurrent Transcriptions | Max audio transcription jobs processed simultaneously |
| Structured Prompt | Custom prompt for structured transcription generation |
| Title Prompt | Custom prompt for title generation |
| Slug Prompt | Custom prompt for slug generation |
| Transcription Timeout | Timeout for each audio transcription or structured transcription request |
| Metadata Generation Timeout | Timeout for each title or slug generation request |
| Retry Policy | Max retries, delay, and jitter for retryable Gemini/network failures |

By default, **Transcription Model** uses **Gemini 3.1 Pro (Preview)** and **Metadata Model** uses **Gemini 3 Flash (Preview)**. **Gemini 3.5 Flash** is supported, but it is not the default.

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
  settings.json.bak # last-known-good copy, refreshed on each successful load
  state.json        # queue state
  state.json.bak    # last-known-good copy, refreshed on each successful load
  working/          # working copies of imported audio
  output/           # default output folder for saved files (configurable)
  backups/          # default backup folder for originals (configurable)
  logs/             # application logs
```

`settings.json` and `state.json` are written atomically (temp file → fsync →
rename) and never overwritten while being read. If one is ever unreadable or
from a newer version, the app halts on launch with a clear message instead of
discarding it; its `.bak` is the recovery copy, and **Reset** preserves both the
unreadable file and its `.bak` as `<name>.corrupt-<timestamp>` copies rather than
deleting them.

## Tech Stack

- [Electron](https://www.electronjs.org/) + [electron-vite](https://electron-vite.org/)
- [React](https://react.dev/) + TypeScript
- [WaveSurfer.js](https://wavesurfer.xyz/) for waveform rendering
- [FFmpeg](https://ffmpeg.org/) (via `ffmpeg-static` / `ffprobe-static`) for audio trimming and probing
- [Google Gemini API](https://ai.google.dev/) (`@google/genai`) for transcription and metadata

## License

MIT
