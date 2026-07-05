import { app } from "electron";
import { copyFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { nanoid } from "nanoid";

import type { MumblerCard } from "@shared/app-shell";
import { formatUtcIsoCompact } from "@shared/timestamps";
import { fileExists, formatError, syncFile } from "./file-io";

export interface SaveTargetPaths {
  audioPath: string;
  jsonPath: string;
  markdownPath: string;
}

export async function pathsConflict(targets: SaveTargetPaths): Promise<boolean> {
  const exists = await Promise.all([
    fileExists(targets.audioPath),
    fileExists(targets.jsonPath),
    fileExists(targets.markdownPath),
  ]);
  return exists.some((value) => value);
}

export async function buildUniqueSuffixedTargets(
  outputDirectory: string,
  baseName: string,
  extension: string,
): Promise<SaveTargetPaths> {
  while (true) {
    const suffixedBase = `${baseName}-${nanoid(8)}`;
    const candidate: SaveTargetPaths = {
      audioPath: join(outputDirectory, `${suffixedBase}${extension}`),
      jsonPath: join(outputDirectory, `${suffixedBase}.json`),
      markdownPath: join(outputDirectory, `${suffixedBase}.md`),
    };
    if (!(await pathsConflict(candidate))) {
      return candidate;
    }
  }
}

export async function finalizeOutputsAtomically(params: {
  sourceAudioPath: string;
  targets: SaveTargetPaths;
  overwrite: boolean;
  jsonContent: string;
  markdownContent: string;
}): Promise<void> {
  await mkdir(dirname(params.targets.audioPath), { recursive: true });

  // Audio/json/markdown targets share one stem (see buildUniqueSuffixedTargets), so each temp/backup
  // path draws its own nanoid rather than a token shared across the three — otherwise they would collide
  // on the same derived name.
  const stemOf = (targetPath: string): string => basename(targetPath, extname(targetPath));
  const tempPathFor = (targetPath: string): string =>
    join(dirname(targetPath), `${stemOf(targetPath)}-${nanoid(8)}.tmp`);
  const backupPathFor = (targetPath: string): string =>
    join(dirname(targetPath), `${stemOf(targetPath)}-${nanoid(8)}.bak`);

  const audioTempPath = tempPathFor(params.targets.audioPath);
  const jsonTempPath = tempPathFor(params.targets.jsonPath);
  const markdownTempPath = tempPathFor(params.targets.markdownPath);

  await copyFile(params.sourceAudioPath, audioTempPath);
  await syncFile(audioTempPath);
  await writeFile(jsonTempPath, params.jsonContent, "utf8");
  await syncFile(jsonTempPath);
  await writeFile(markdownTempPath, params.markdownContent, "utf8");
  await syncFile(markdownTempPath);

  const audioBackupPath = backupPathFor(params.targets.audioPath);
  const jsonBackupPath = backupPathFor(params.targets.jsonPath);
  const markdownBackupPath = backupPathFor(params.targets.markdownPath);

  const audioHadExisting = params.overwrite && (await fileExists(params.targets.audioPath));
  const jsonHadExisting = params.overwrite && (await fileExists(params.targets.jsonPath));
  const markdownHadExisting = params.overwrite && (await fileExists(params.targets.markdownPath));

  let audioFinalized = false;
  let jsonFinalized = false;
  let markdownFinalized = false;

  try {
    if (audioHadExisting) {
      await rename(params.targets.audioPath, audioBackupPath);
    }
    if (jsonHadExisting) {
      await rename(params.targets.jsonPath, jsonBackupPath);
    }
    if (markdownHadExisting) {
      await rename(params.targets.markdownPath, markdownBackupPath);
    }

    await rename(audioTempPath, params.targets.audioPath);
    audioFinalized = true;
    await rename(jsonTempPath, params.targets.jsonPath);
    jsonFinalized = true;
    await rename(markdownTempPath, params.targets.markdownPath);
    markdownFinalized = true;
  } catch (error: unknown) {
    if (markdownFinalized) {
      await rm(params.targets.markdownPath, { force: true }).catch(() => undefined);
    }
    if (jsonFinalized) {
      await rm(params.targets.jsonPath, { force: true }).catch(() => undefined);
    }
    if (audioFinalized) {
      await rm(params.targets.audioPath, { force: true }).catch(() => undefined);
    }

    if (audioHadExisting && (await fileExists(audioBackupPath))) {
      await rename(audioBackupPath, params.targets.audioPath).catch(() => undefined);
    }
    if (jsonHadExisting && (await fileExists(jsonBackupPath))) {
      await rename(jsonBackupPath, params.targets.jsonPath).catch(() => undefined);
    }
    if (markdownHadExisting && (await fileExists(markdownBackupPath))) {
      await rename(markdownBackupPath, params.targets.markdownPath).catch(() => undefined);
    }

    await rm(audioTempPath, { force: true }).catch(() => undefined);
    await rm(jsonTempPath, { force: true }).catch(() => undefined);
    await rm(markdownTempPath, { force: true }).catch(() => undefined);

    throw new Error(`Failed to finalize output files: ${formatError(error)}`);
  }

  // Backup cleanup is best-effort: failure here cannot undo the already-committed
  // renames above, so errors are swallowed to avoid masking a successful save.
  if (audioHadExisting) {
    await rm(audioBackupPath, { force: true }).catch(() => undefined);
  }
  if (jsonHadExisting) {
    await rm(jsonBackupPath, { force: true }).catch(() => undefined);
  }
  if (markdownHadExisting) {
    await rm(markdownBackupPath, { force: true }).catch(() => undefined);
  }
}

export function buildOutputPayload(params: {
  card: MumblerCard;
  finalProfile: MumblerCard["audioProfile"];
  finalDurationSec: number | null;
  finalizedAtUtc: number;
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    appVersion: app.getVersion(),
    originalFilename: params.card.originalFilename,
    importSource: params.card.importSource,
    timestamps: {
      confirmedLocal: params.card.timestamps.confirmedLocal,
      confirmedUtc: formatUtcIsoCompact(params.card.timestamps.confirmedUtc),
      effectiveLocal: params.card.timestamps.effectiveLocal,
      effectiveUtc: formatUtcIsoCompact(params.card.timestamps.effectiveUtc),
      timezone: params.card.timestamps.timezone,
      transcribedAtUtc: params.card.ai.transcription !== null ? formatUtcIsoCompact(params.card.ai.transcription.generatedAtUtc) : null,
      finalizedAtUtc: formatUtcIsoCompact(params.finalizedAtUtc),
    },
    trim:
      params.card.trim.frontMarkerSec === null && params.card.trim.backMarkerSec === null
        ? null
        : params.card.trim,
    duration: {
      originalSec: params.card.durationSec,
      finalSec: params.finalDurationSec,
    },
    transcription: {
      raw: params.card.transcription.text,
      structured: params.card.metadata.structured,
      title: params.card.metadata.title,
      slug: params.card.metadata.slug,
    },
    providers: {
      transcription: params.card.ai.transcription !== null ? {
        ...params.card.ai.transcription,
        generatedAtUtc: formatUtcIsoCompact(params.card.ai.transcription.generatedAtUtc),
      } : null,
      structured: params.card.ai.structured !== null ? {
        ...params.card.ai.structured,
        generatedAtUtc: formatUtcIsoCompact(params.card.ai.structured.generatedAtUtc),
      } : null,
      title: params.card.ai.title !== null ? {
        ...params.card.ai.title,
        generatedAtUtc: formatUtcIsoCompact(params.card.ai.title.generatedAtUtc),
      } : null,
      slug: params.card.ai.slug !== null ? {
        ...params.card.ai.slug,
        generatedAtUtc: formatUtcIsoCompact(params.card.ai.slug.generatedAtUtc),
      } : null,
    },
    audio: {
      finalCodec: params.finalProfile?.codecName ?? null,
      finalBitrateKbps: params.finalProfile?.bitRateKbps ?? null,
      finalSampleRateHz: params.finalProfile?.sampleRateHz ?? null,
      finalChannels: params.finalProfile?.channels ?? null,
      trimDecision: params.card.trimDecision?.kind ?? "not-needed",
    },
  };
}

export function yamlDoubleQuotedString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, "\\n");
  return `"${escaped}"`;
}

export function buildMarkdownContent(params: {
  card: MumblerCard;
  audioFilename: string;
  finalDurationSec: number | null;
}): string {
  const title = params.card.metadata.title ?? "";
  const slug = params.card.metadata.slug ?? "";
  const date = formatUtcIsoCompact(params.card.timestamps.effectiveUtc);
  const duration = params.finalDurationSec ?? null;
  const body = params.card.metadata.structured ?? "";

  const lines: string[] = [
    "---",
    `schema_version: 1`,
    `date: ${yamlDoubleQuotedString(date)}`,
    `audio: ${yamlDoubleQuotedString(params.audioFilename)}`,
    `duration: ${duration === null ? "null" : duration}`,
    `title: ${yamlDoubleQuotedString(title)}`,
    `slug: ${yamlDoubleQuotedString(slug)}`,
    "---",
    "",
    body,
  ];

  let content = lines.join("\n");
  if (!content.endsWith("\n")) {
    content += "\n";
  }
  return content;
}

export function computeFinalDuration(card: MumblerCard, probedDurationSec: number | null): number | null {
  if (probedDurationSec !== null) {
    return probedDurationSec;
  }

  if (card.durationSec === null) {
    return null;
  }

  const startSec = card.trim.frontMarkerSec ?? 0;
  const endSec = card.trim.backMarkerSec ?? card.durationSec;
  return Math.max(0, Math.round((endSec - startSec) * 1000) / 1000);
}
