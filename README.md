# Mumbler

Transcribe voice recordings with AI, structure the transcript, and generate titles and slugs ready to publish. Mumbler is a desktop app built on Electron, React, and TypeScript: import recordings, trim silence on a waveform, then generate a transcription, a structured transcription, a title, and a URL slug — saved together as audio plus JSON and Markdown sidecars. It's for podcasters, note-takers, and writers who want clean, structured text out of raw recordings. Transcription runs through your own Gemini API key.

## Features

- **Waveform editor** — set front/back trim markers to cut silence before generation
- **AI pipeline** — transcription → structured transcription → title → slug, each a dependent step that regenerates downstream outputs when changed
- **Separate model choices** — choose a Gemini model for transcription, another for the structured transcription, and one for titles and slugs. The defaults use a balanced model for longer work and a fast model for short metadata.
- **Queue** — import many files and process them concurrently, with a configurable limit
- **Timestamp parsing** — pull the recording datetime from filenames via configurable regex, prompting when none matches
- **Atomic save** — writes audio + JSON + Markdown together, with rollback on failure
- **IME-safe** — Japanese/Chinese/Korean input works in every text field
- **Light and dark themes** — follows the system by default; pick Light or Dark in Settings

## Requirements

- macOS 13 or later (Apple Silicon) or Windows (x64) — Electron desktop app
- A Google Gemini API key (the AI features call Gemini, billed to your key)
- **ffmpeg and ffprobe**, used to read and trim audio. When you choose to install them, Mumbler downloads checksum-verified builds from the third-party community builders [Martin Riedl](https://ffmpeg.martin-riedl.de/) (macOS) or [BtbN](https://github.com/BtbN/FFmpeg-Builds) (Windows). Installing both currently downloads about 60 MB on macOS or 340 MB on Windows; nothing downloads or updates silently. FFmpeg's licence and source information are published at [ffmpeg.org](https://ffmpeg.org/legal.html).
- Node.js 20.19+ on the Node 20 line, or Node.js 22.12+ — only to build or run from source

## Download

Prebuilt installers and portable builds for macOS (Apple Silicon) and Windows are on the [Releases](https://github.com/nao7sep/mumbler/releases/latest) page. These builds are **unsigned**, so the OS warns the first time you open one:

- **macOS** — right-click the app and choose **Open** (or run `xattr -dr com.apple.quarantine /Applications/Mumbler.app`).
- **Windows** — on the SmartScreen prompt, click **More info → Run anyway**.

## Run from source

Double-click the launcher for your platform (`scripts/run-dev.command` on macOS, `scripts/run-dev.ps1` on Windows), or run it by hand:

```bash
npm install
npm run dev
```

On first launch, open Settings and enter your Gemini API key. Saved files default to `~/.mumbler/output`.

Each model field holds its default until you type another model ID. An ID Mumbler does not support is kept and marked under its field; it gets a plain request, and Gemini reports an invalid or retired model when a job calls it. You can change the endpoint while the request parameters continue to follow the model ID.

## Tests

`npm test` runs the type check and the whole ordinary suite, the same set every time. `npm run test:full` runs that, then the live lane: the real app runtime against the real Gemini API and the managed ffmpeg and ffprobe, over the shared test-fixture corpus in the company repository, which must be checked out beside this one. Export `GEMINI_API_KEY` first; the lane makes a few paid Gemini calls, and the full run fails without the key. The first run downloads ffmpeg and ffprobe into `node_modules/.cache`, and later runs download them again only when a newer build is available.

## License

[GNU GPL v3 or later](LICENSE) © 2026 Yoshinao Inoguchi

## Contact

Yoshinao Inoguchi — yoshinao@inoguchi.com — <https://inoguchi.com>
