#!/usr/bin/env node
// Fills a folder with recordings for trying Mumbler's import by hand: names in
// every form the default timestamp pattern reads (four- or two-digit year,
// "-" or "_" before the time, with or without seconds, with text around it),
// names that hold no time, recording times embedded the ways recorders store
// them, and spread-out file dates. Importing moves originals out of the folder
// by default, so run it again to refill it.
//
//   node scripts/make-test-recordings.mjs [folder]
//
// The default folder is ~/Desktop/Mumbler Test Recordings. The audio comes from
// the shared synthetic fixtures in company/assets/test-fixtures; ffmpeg on PATH
// copies each one without re-encoding and adds its tags.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const fixtures = resolve(here, "../../company/assets/test-fixtures/audio");
const target = process.argv[2] ?? join(homedir(), "Desktop", "Mumbler Test Recordings");

const source = {
  m4a: join(fixtures, "speech/english-japanese-pronunciation-96k.m4a"),
  mp3: join(fixtures, "speech/english-natural-64k.mp3"),
  wav: join(fixtures, "speech/english-natural-16k-mono.wav"),
  flac: join(fixtures, "dialogue/dialogue-english-alternating.flac"),
  aiff: join(fixtures, "speech/english-japanese-pronunciation-original.aiff"),
  japanese: join(fixtures, "dialogue/dialogue-mixed-japanese-english.flac"),
};

// name, source, embedded tags (ffmpeg -metadata), file modified time (UTC).
const recordings = [
  // yyyymmdd-hhmmss, with the matching MP4 creation time (UTC) inside.
  ["20261014-153012.m4a", source.m4a, { creation_time: "2026-10-14T06:30:12Z" }, "2026-10-14T06:31:00Z"],
  // yyyymmdd_hhmmss, with an ID3 recording date (local) that disagrees by a minute.
  ["20261014_091500.mp3", source.mp3, { date: "2026-10-14 09:16:00" }, "2026-10-14T00:20:00Z"],
  // yyyymmdd-hhmm, with Broadcast Wave origination fields (local).
  ["20261013-2210.wav", source.wav, { origination_date: "2026-10-13", origination_time: "22:10:00" }, "2026-10-13T13:15:00Z"],
  // yyyymmdd_hhmm.
  ["20261013_0745.flac", source.flac, {}, "2026-10-12T22:50:00Z"],
  // yymmdd-hhmmss.
  ["261012-183045.m4a", source.m4a, {}, "2026-10-12T09:31:00Z"],
  // yymmdd_hhmmss.
  ["261012_120000.mp3", source.mp3, {}, "2026-10-12T03:05:00Z"],
  // yymmdd-hhmm.
  ["261011-0930.wav", source.wav, {}, "2026-10-11T00:35:00Z"],
  // yymmdd_hhmm.
  ["261011_2359.aiff", source.aiff, {}, "2026-10-11T15:00:00Z"],
  // Text before and after the time, as recorders and apps add.
  ["REC_20261010-081520_memo.mp3", source.mp3, {}, "2026-10-09T23:20:00Z"],
  ["Voice 251231_2330.m4a", source.m4a, {}, "2025-12-31T14:35:00Z"],
  // No time in the name: an iPad export named after the place, with its exact time inside.
  ["Shibuya Station.m4a", source.m4a, { creation_time: "2026-10-09T04:12:33Z" }, "2026-10-09T04:15:00Z"],
  // No time in the name, Broadcast Wave origination inside.
  ["Team meeting notes.wav", source.wav, { origination_date: "2026:10:08", origination_time: "10:00:00" }, "2026-10-08T02:30:00Z"],
  // No time anywhere but the file dates.
  ["渋谷駅前.flac", source.japanese, {}, "2026-10-07T11:00:00Z"],
  ["untitled.mp3", source.mp3, {}, "2026-10-06T08:00:00Z"],
];

for (const path of Object.values(source)) {
  if (!existsSync(path)) throw new Error(`Missing fixture: ${path}`);
}
mkdirSync(target, { recursive: true });

for (const [name, from, tags, modified] of recordings) {
  const to = join(target, name);
  const metadata = Object.entries(tags).flatMap(([key, value]) => ["-metadata", `${key}=${value}`]);
  // Broadcast Wave fields are written only when the muxer is asked for a bext chunk.
  const bext = name.endsWith(".wav") && "origination_date" in tags ? ["-write_bext", "1"] : [];
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", from, "-map", "0:a", "-c", "copy", ...metadata, ...bext, to]);
  const time = new Date(modified);
  utimesSync(to, time, time);
  console.log(name);
}
console.log(`\n${recordings.length} recordings in ${target}`);
