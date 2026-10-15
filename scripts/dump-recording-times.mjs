#!/usr/bin/env node
// Prints the date and time tags ffprobe reports for each recording given, and
// nothing else, so a real recorder's or phone's tag layout can become a test
// case without its audio, location or device details leaving the machine.
//
//   node scripts/dump-recording-times.mjs <recording>...
//
// Uses Mumbler's managed ffprobe in ~/.mumbler/bin when it is there, otherwise
// ffprobe on PATH.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

const managed = join(homedir(), ".mumbler", "bin", process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
const ffprobe = existsSync(managed) ? managed : "ffprobe";
// Tag names that can hold a recording time, compared without case.
const TIME_TAG = /date|time|year|^tdrc$|^tyer$|^tdat$|^icrd$/i;

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("Usage: node scripts/dump-recording-times.mjs <recording>...");
  process.exit(1);
}
for (const file of files) {
  const probe = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-show_entries", "format=format_name:format_tags", "-of", "json", file], { encoding: "utf8" }));
  const tags = Object.fromEntries(Object.entries(probe.format?.tags ?? {}).filter(([name]) => TIME_TAG.test(name) && !/location/i.test(name)));
  console.log(JSON.stringify({ extension: extname(basename(file)).toLowerCase(), format: probe.format?.format_name ?? null, tags }));
}
