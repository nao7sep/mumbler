// Everything measure-lines knows about Mumbler: how to start it, the state it
// is seeded with, and how to reach each surface that draws lines. Pointing the
// tool at another Electron app means writing one module shaped like this one.
//
// seed() runs in the plain Node launcher before Electron starts; afterStart()
// and the surface steps run in the harness inside Electron's main process.

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const appName = "Mumbler";
// storage-path-conventions: the relocation variable for the whole data root.
export const dataDirEnv = "MUMBLER_DATA_DIR";
export const mainEntry = join(repo, "out", "main", "index.js");
export const builtCheck = [mainEntry, join(repo, "out", "renderer", "index.html"), join(repo, "out", "preload", "index.cjs")];

// Fixed content sizes, so every run captures the same layout.
export const windows = {
  main: { page: "index.html", width: 1480, height: 900 },
  records: { page: "records.html", width: 1240, height: 800 },
};

export const notes = [
  "Not captured: the save-conflict dialog (reaching it runs a real save through ffmpeg/ffprobe), the app-wide error dialog (raised only by a main-process crash), the startup-failure window, drag-over states, hover/pressed states and native menus.",
  "The seeded ffmpeg/ffprobe are stub scripts that only print a version, so Managed tools shows installed tools; nothing that runs them is captured.",
  "The Gemini endpoint is a local loopback server that accepts requests and never answers, so one queued card stays Transcribing; the API key is a fake placeholder.",
];

const en = JSON.parse(await readFile(join(repo, "src", "shared", "i18n", "locales", "en.json"), "utf8"));
export function t(key) {
  if (!(key in en)) throw new Error(`Unknown message key: ${key}`);
  return en[key];
}

// ── Seed ────────────────────────────────────────────────────────────────────

const HOUR = 3600_000;

// A deterministic mono 16-bit WAV with a speech-like envelope, so the waveform
// has shape.
function speechWav(seconds, seed) {
  const rate = 16_000;
  const samples = seconds * rate;
  const data = Buffer.alloc(samples * 2);
  let state = seed;
  const random = () => ((state = (state * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
  let envelope = 0;
  let target = 0;
  for (let i = 0; i < samples; i += 1) {
    if (i % 2400 === 0) target = random() < 0.25 ? 0.02 : 0.2 + random() * 0.6;
    envelope += (target - envelope) * 0.002;
    const tone = Math.sin((2 * Math.PI * 180 * i) / rate) + 0.5 * Math.sin((2 * Math.PI * 410 * i) / rate);
    const value = Math.max(-1, Math.min(1, envelope * (tone * 0.6 + (random() - 0.5) * 0.4)));
    data.writeInt16LE(Math.round(value * 32_767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function localText(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

const TRANSCRIPT = [
  "Okay, quick note on the walk this morning. The idea for the newsletter is to stop sending one long letter a month and send a short one every week instead, three items, one of them always a question for readers.",
  "The worry is that weekly turns into filler. So the rule would be: if there are not three things worth sending, skip the week and say so. People seem to trust that more than a schedule kept for its own sake.",
  "Also, the archive page needs a search box. Half the replies last month were people asking where an older issue went.",
].join("\n\n");

const STRUCTURED = [
  "# Newsletter cadence",
  "",
  "## Proposal",
  "- Move from one long monthly letter to a short weekly one.",
  "- Three items per issue; one is always a question for readers.",
  "",
  "## Guard against filler",
  "- Skip a week when there are not three items worth sending, and say so.",
  "",
  "## Archive",
  "- Add search to the archive page; readers keep asking for older issues.",
].join("\n");

function card(id, now, overrides) {
  const confirmedUtc = overrides.confirmedUtc;
  const local = localText(confirmedUtc);
  return {
    id,
    originalFilename: `${local.replace(/:/g, "-")}.wav`,
    importSource: "file-picker",
    sourceFilePath: "",
    audioProfile: { formatName: "wav", codecName: "pcm_s16le", bitRateKbps: 256, sampleRateHz: 16_000, channels: 1 },
    durationSec: 12,
    fileSizeBytes: 12 * 32_000 + 44,
    timestamps: { confirmedLocal: local, confirmedUtc, timezone: "UTC", frontTrimOffsetSec: 0, effectiveLocal: local, effectiveUtc: confirmedUtc },
    trim: { frontMarkerSec: null, backMarkerSec: null },
    trimDecision: null,
    transcribedTrim: null,
    transcription: { text: null },
    metadata: { structured: null, title: null, slug: null },
    ai: { transcription: null, structured: null, title: null, slug: null },
    status: "Imported",
    activeStep: null,
    queuedMode: null,
    queuedAtUtc: null,
    lastError: null,
    createdAtUtc: now - 2 * HOUR,
    updatedAtUtc: now - HOUR,
    ...overrides,
  };
}

function finished(now, text = TRANSCRIPT) {
  const run = (model) => ({ provider: "gemini", model, generatedAtUtc: now - HOUR });
  return {
    status: "Ready to Save",
    transcription: { text },
    metadata: { structured: STRUCTURED, title: "A weekly newsletter with three items", slug: "weekly-newsletter-three-items" },
    ai: { transcription: run("gemini-2.5-pro"), structured: run("gemini-2.5-flash"), title: run("gemini-2.5-flash-lite"), slug: run("gemini-2.5-flash-lite") },
  };
}

// The seeded cards, keyed by the role each plays in the surfaces below.
const CARD_IDS = {
  ready: "seed-ready",
  stale: "seed-stale",
  imported: "seed-imported",
  error: "seed-error",
  cancelled: "seed-cancelled",
  transcribing: "seed-queued-first",
  queued: "seed-queued-second",
};

export async function seed({ dataDir, blackHoleUrl }) {
  const now = Date.now();
  const day = Date.UTC(2026, 8, 28, 7, 41, 12);
  const working = join(dataDir, "working");
  const inbox = join(dataDir, "inbox");
  await mkdir(working, { recursive: true });
  await mkdir(inbox, { recursive: true });
  await mkdir(join(dataDir, "transcripts"), { recursive: true });
  await mkdir(join(dataDir, "bin"), { recursive: true });

  const cards = [
    card(CARD_IDS.ready, now, {
      confirmedUtc: day,
      ...finished(now),
      trim: { frontMarkerSec: 1.5, backMarkerSec: 10.5 },
      transcribedTrim: { frontMarkerSec: 1.5, backMarkerSec: 10.5 },
      trimDecision: {
        kind: "stream-copy", toleranceSec: 0.5, requestedStartSec: 1.5, requestedEndSec: 10.5,
        searchStartFromSec: 1, searchStartToSec: 2, searchEndFromSec: 10, searchEndToSec: 11,
        chosenStartBoundarySec: 1.48, chosenEndBoundarySec: 10.52, startDeltaSec: -0.02, endDeltaSec: 0.02,
        reason: "Keyframes within tolerance; stream copy keeps the original audio.", analyzedAtUtc: now - HOUR,
      },
    }),
    card(CARD_IDS.stale, now, {
      confirmedUtc: day + 5 * HOUR,
      ...finished(now),
      trim: { frontMarkerSec: 2, backMarkerSec: null },
      transcribedTrim: { frontMarkerSec: null, backMarkerSec: null },
    }),
    card(CARD_IDS.imported, now, { confirmedUtc: day + 26 * HOUR }),
    card(CARD_IDS.error, now, {
      confirmedUtc: day + 28 * HOUR,
      status: "Error",
      lastError: { message: "The provider rejected the request.", providerReason: "Audio could not be processed.", occurredAtUtc: now - HOUR / 2, failedStep: "transcription" },
    }),
    card(CARD_IDS.cancelled, now, { confirmedUtc: day + 30 * HOUR, status: "Cancelled" }),
    card(CARD_IDS.transcribing, now, { confirmedUtc: day + 50 * HOUR, status: "Queued", queuedMode: "generate", queuedAtUtc: now - 60_000 }),
    card(CARD_IDS.queued, now, { confirmedUtc: day + 52 * HOUR, status: "Queued", queuedMode: "generate", queuedAtUtc: now - 30_000 }),
  ];
  let wavSeed = 7;
  for (const item of cards) {
    item.sourceFilePath = join(working, `${item.id}.wav`);
    await writeFile(item.sourceFilePath, speechWav(12, (wavSeed += 11)));
    const transcript = { schemaVersion: 1, cardId: item.id, transcription: item.transcription.text, structured: item.metadata.structured };
    if (transcript.transcription !== null || transcript.structured !== null) {
      await writeFile(join(dataDir, "transcripts", `${Buffer.from(item.id, "utf8").toString("hex")}.json`), JSON.stringify(transcript));
    }
    item.transcription = { text: null };
    item.metadata = { ...item.metadata, structured: null };
  }

  const pendingImports = [0, 1].map((n) => {
    const utc = Date.UTC(2026, 9, 1, 18, 5 + n * 7, 33);
    const name = `${localText(utc).replace(/:/g, "-")}.wav`;
    return {
      id: `seed-pending-${n}`,
      originalFilename: name,
      importSource: "drag-and-drop",
      originalSourcePath: join(inbox, name),
      workingFilePath: join(working, `seed-pending-${n}.wav`),
      fileSizeBytes: 12 * 32_000 + 44,
      localTimestampText: localText(utc),
      timezone: "UTC",
      utcTimestampText: localText(utc),
      parseStatus: "parsed",
      deleteOriginalOnConfirm: false,
      copyToBackupOnConfirm: false,
      createdAtUtc: now - 60_000,
      updatedAtUtc: now - 60_000,
    };
  });
  for (const item of pendingImports) {
    const audio = speechWav(12, (wavSeed += 11));
    await writeFile(item.originalSourcePath, audio);
    await writeFile(item.workingFilePath, audio);
  }

  await writeFile(join(dataDir, "queue.json"), JSON.stringify({ schemaVersion: 2, pendingImports, cards }, null, 2));
  await writeFile(join(dataDir, "config.json"), JSON.stringify({
    language: "en",
    "gemini.endpoint": blackHoleUrl,
    concurrencyLimit: 1,
    checkUpdatesAtLaunch: false,
  }, null, 2));
  const keys = join(dataDir, "api-keys.json");
  await writeFile(keys, JSON.stringify({ keys: { gemini: "measure-lines-placeholder-not-a-key" } }));
  await chmod(keys, 0o600);

  // Stub tools that only answer the version probe; ffmpeg reports an update.
  for (const name of ["ffmpeg", "ffprobe"]) {
    const tool = join(dataDir, "bin", name);
    await writeFile(tool, `#!/bin/sh\necho "${name} version 8.0 Copyright (c) the FFmpeg developers"\n`);
    await chmod(tool, 0o755);
  }
  const checked = new Date(now - HOUR).toISOString();
  await writeFile(join(dataDir, "dependencies.json"), JSON.stringify({
    schemaVersion: 1,
    tools: { ffmpeg: { desiredVersion: "8.0.1", lastCheckedAtUtc: checked }, ffprobe: { desiredVersion: "8.0", lastCheckedAtUtc: checked } },
    lastCheckAttemptAtUtc: checked,
  }, null, 2));
}

// Adds a previous launch's log lines and provider calls to records.sqlite3,
// once the app has created it, so the Records window has every kind of row.
export async function afterStart({ dataDir, waitUntil }) {
  const dbPath = join(dataDir, "records.sqlite3");
  await waitUntil(() => existsSync(dbPath), "records.sqlite3 to exist");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    await waitUntil(() => db.prepare("SELECT count(*) AS n FROM logs").get().n > 0, "the first log line");
    const session = new Date(Date.now() - 26 * HOUR).toISOString();
    const at = (minutes) => new Date(Date.parse(session) + minutes * 60_000).toISOString();
    const log = db.prepare("INSERT INTO logs (session, time, level, op, message, card_id, details, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    log.run(session, at(0), "info", "app.startup", "Application runtime initialized.", null, JSON.stringify({ appVersion: "0.1.0", cardCount: 5 }), null);
    log.run(session, at(3), "warn", "tools.version-unreadable", "Installed audio tool did not report a version.", null, JSON.stringify({ tool: "ffprobe" }), null);
    log.run(session, at(9), "error", "card.cleanup", "Saved card was removed from the queue, but the queue could not be saved.", CARD_IDS.ready,
      JSON.stringify({ cardId: CARD_IDS.ready }), JSON.stringify({ name: "Error", message: "EBUSY: resource busy or locked" }));
    const call = db.prepare(`INSERT INTO provider_calls (session, started_at, finished_at, card_id, step, attempt, provider, operation,
      endpoint, model, request, response, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const request = (model) => JSON.stringify({ model, contents: [{ role: "user", parts: [{ text: "Transcribe the audio." }, { inlineData: { mimeType: "audio/wav", data: "<384044 bytes>" } }] }] }, null, 2);
    call.run(session, at(4), at(5), CARD_IDS.ready, "transcription", 1, "gemini", "models.generateContent", "https://generativelanguage.googleapis.com",
      "gemini-2.5-pro", request("gemini-2.5-pro"), JSON.stringify({ candidates: [{ content: { parts: [{ text: TRANSCRIPT }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 812, candidatesTokenCount: 164 } }, null, 2), null);
    call.run(session, at(5), at(6), CARD_IDS.ready, "structured", 1, "gemini", "models.generateContent", "https://generativelanguage.googleapis.com",
      "gemini-2.5-flash", request("gemini-2.5-flash"), JSON.stringify({ candidates: [{ content: { parts: [{ text: STRUCTURED }] } }] }, null, 2), null);
    call.run(session, at(7), at(7), CARD_IDS.error, "transcription", 2, "gemini", "models.generateContent", "https://generativelanguage.googleapis.com",
      "gemini-2.5-pro", request("gemini-2.5-pro"), null, JSON.stringify({ status: 400, message: "Audio could not be processed." }, null, 2));
  } finally {
    db.close();
  }
}

// ── Surfaces ────────────────────────────────────────────────────────────────
// Each surface names its window and how to reach it. `fresh` reloads the
// window first, so it starts from the app's own state rather than the previous
// surface's; a surface without it continues from the one before. `leave`
// undoes what the surface opened when the next one depends on it.

const readyName = () => `${localText(Date.UTC(2026, 8, 28, 7, 41, 12)).replace(/:/g, "-")}.wav`;
const cardName = (hoursAfter) => `${localText(Date.UTC(2026, 8, 28, 7, 41, 12) + hoursAfter * HOUR).replace(/:/g, "-")}.wav`;

async function selectCard(main, name, tab) {
  await main.waitFor(".queue-row");
  await main.click(".queue-row", name);
  await main.waitFor(".queue-row--selected", name);
  await main.click(".app-tab", t(tab));
  await main.waitFor(".app-tab--active", t(tab));
}

async function openMenuItem(main, key) {
  await main.waitFor(".queue-row");
  await main.click(`button[aria-label="${t("menu.open")}"]`);
  await main.click(".app-menu-item", t(key));
}

async function openSettingsTab(main, tab) {
  await openMenuItem(main, "menu.settings");
  await main.waitFor(".settings-tabs");
  await main.click(".settings-tabs .app-tab", t(tab));
  await main.waitFor(".settings-tabs .app-tab--active", t(tab));
}

export const surfaces = [
  {
    name: "import-review",
    window: "main",
    fresh: true,
    open: async ({ main }) => main.waitFor(".modal-card__header h2", t("review.title")),
  },
  {
    name: "import-review-discard",
    window: "main",
    open: async ({ main }) => {
      await main.setValue(".modal-card input", "2026-10-01 18:05:34");
      await main.click(".modal-card .button", t("common.cancel"));
      await main.waitFor(".modal-card__header h2", t("decision.discardTitle"));
    },
    leave: async ({ main }) => {
      await main.click(".modal-card .button", t("decision.discard"));
      await main.waitForGone(".modal-backdrop");
    },
  },
  { name: "main-ready-info", window: "main", fresh: true, open: ({ main }) => selectCard(main, readyName(), "detail.tabInfo") },
  { name: "main-ready-trim", window: "main", fresh: true, open: ({ main }) => selectCard(main, readyName(), "detail.tabTrim") },
  { name: "main-ready-transcribe", window: "main", fresh: true, open: ({ main }) => selectCard(main, readyName(), "detail.tabTranscribe") },
  { name: "main-ready-output", window: "main", fresh: true, open: ({ main }) => selectCard(main, readyName(), "detail.tabOutput") },
  { name: "main-stale-transcribe", window: "main", fresh: true, open: ({ main }) => selectCard(main, cardName(5), "detail.tabTranscribe") },
  { name: "main-error-transcribe", window: "main", fresh: true, open: ({ main }) => selectCard(main, cardName(28), "detail.tabTranscribe") },
  { name: "main-cancelled-info", window: "main", fresh: true, open: ({ main }) => selectCard(main, cardName(30), "detail.tabInfo") },
  {
    name: "main-transcribing-transcribe",
    window: "main",
    fresh: true,
    open: async ({ main }) => {
      await main.waitFor(".queue-row--transcribing");
      await selectCard(main, cardName(50), "detail.tabTranscribe");
    },
  },
  { name: "main-imported-trim", window: "main", fresh: true, open: ({ main }) => selectCard(main, cardName(26), "detail.tabTrim") },
  {
    name: "app-menu",
    window: "main",
    fresh: true,
    open: async ({ main }) => {
      await main.waitFor(".queue-row");
      await main.click(`button[aria-label="${t("menu.open")}"]`);
      await main.waitFor(".app-menu-item");
    },
  },
  { name: "settings-general", window: "main", fresh: true, open: ({ main }) => openSettingsTab(main, "settings.tabGeneral") },
  { name: "settings-ai", window: "main", fresh: true, open: ({ main }) => openSettingsTab(main, "settings.tabAi") },
  { name: "settings-prompts", window: "main", fresh: true, open: ({ main }) => openSettingsTab(main, "settings.tabPrompts") },
  { name: "settings-pipeline", window: "main", fresh: true, open: ({ main }) => openSettingsTab(main, "settings.tabPipeline") },
  {
    name: "settings-discard",
    window: "main",
    fresh: true,
    open: async ({ main }) => {
      await openSettingsTab(main, "settings.tabGeneral");
      await main.setValue(`.modal-card input[placeholder="${t("settings.uiFontPlaceholder")}"]`, "Georgia");
      await main.click(".modal-card .button", t("common.cancel"));
      await main.waitFor(".modal-card__header h2", t("decision.discardTitle"));
    },
  },
  {
    name: "managed-tools",
    window: "main",
    fresh: true,
    open: async ({ main }) => {
      await openMenuItem(main, "menu.managedTools");
      await main.waitFor(".modal-card__header h2", t("tools.title"));
    },
  },
  {
    name: "keyboard-shortcuts",
    window: "main",
    fresh: true,
    open: async ({ main }) => {
      await openMenuItem(main, "menu.keyboardShortcuts");
      await main.waitFor(".modal-card__header h2", t("shortcuts.title"));
    },
  },
  {
    name: "about",
    window: "main",
    fresh: true,
    open: async ({ main }) => {
      await openMenuItem(main, "menu.about");
      await main.waitFor(".modal-card__header h2", t("about.title"));
    },
  },
  {
    name: "confirm-regenerate",
    window: "main",
    fresh: true,
    open: async ({ main }) => {
      await selectCard(main, readyName(), "detail.tabTranscribe");
      await main.click(".field-actions .button", t("transcribe.generate"));
      await main.waitFor(".modal-backdrop");
    },
  },
  {
    name: "confirm-remove",
    window: "main",
    fresh: true,
    open: async ({ main }) => {
      await selectCard(main, readyName(), "detail.tabOutput");
      await main.click(".button--danger", t("common.remove"));
      await main.waitFor(".modal-card__header h2", t("decision.removeTitle"));
    },
  },
  {
    name: "records-log",
    window: "records",
    open: async ({ main, openWindow }) => {
      await main.eval(() => window.mumbler.openRecordsWindow());
      const records = await openWindow("records");
      await records.waitFor(".records-row", "card.cleanup");
      await records.click(".records-row", "card.cleanup");
      await records.waitFor(".records-detail__title");
    },
  },
  {
    name: "records-provider-call",
    window: "records",
    open: async ({ records }) => {
      await records.click(".records-row", t("records.kindProviderCall"));
      await records.waitFor(".records-detail__pills", t("records.kindProviderCall"));
    },
  },
];
