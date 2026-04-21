import { app } from "electron";
import { copyFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { nanoid } from "nanoid";

import type { MumblerCard } from "@shared/app-shell";
import { fileExists, formatError, syncFile } from "./file-io";

export async function pathsConflict(audioPath: string, jsonPath: string): Promise<boolean> {
  const [audioExists, jsonExists] = await Promise.all([fileExists(audioPath), fileExists(jsonPath)]);
  return audioExists || jsonExists;
}

export async function buildUniqueSuffixedTargets(
  outputDirectory: string,
  baseName: string,
  extension: string,
): Promise<{ audioPath: string; jsonPath: string }> {
  while (true) {
    const suffixedBase = `${baseName}-${nanoid(8)}`;
    const audioPath = join(outputDirectory, `${suffixedBase}${extension}`);
    const jsonPath = join(outputDirectory, `${suffixedBase}.json`);
    if (!(await pathsConflict(audioPath, jsonPath))) {
      return { audioPath, jsonPath };
    }
  }
}

export async function finalizeOutputsAtomically(params: {
  sourceAudioPath: string;
  audioTargetPath: string;
  jsonTargetPath: string;
  overwrite: boolean;
  jsonContent: string;
}): Promise<void> {
  await mkdir(dirname(params.audioTargetPath), { recursive: true });

  const token = nanoid(8);
  const audioTempPath = join(
    dirname(params.audioTargetPath),
    `.${basename(params.audioTargetPath)}.${token}.tmp`,
  );
  const jsonTempPath = join(
    dirname(params.jsonTargetPath),
    `.${basename(params.jsonTargetPath)}.${token}.tmp`,
  );

  await copyFile(params.sourceAudioPath, audioTempPath);
  await syncFile(audioTempPath);
  await writeFile(jsonTempPath, params.jsonContent, "utf8");
  await syncFile(jsonTempPath);

  const audioBackupPath = `${params.audioTargetPath}.${token}.bak`;
  const jsonBackupPath = `${params.jsonTargetPath}.${token}.bak`;
  const audioHadExisting = params.overwrite && (await fileExists(params.audioTargetPath));
  const jsonHadExisting = params.overwrite && (await fileExists(params.jsonTargetPath));

  let audioFinalized = false;
  let jsonFinalized = false;

  try {
    if (audioHadExisting) {
      await rename(params.audioTargetPath, audioBackupPath);
    }
    if (jsonHadExisting) {
      await rename(params.jsonTargetPath, jsonBackupPath);
    }

    await rename(audioTempPath, params.audioTargetPath);
    audioFinalized = true;
    await rename(jsonTempPath, params.jsonTargetPath);
    jsonFinalized = true;

    if (audioHadExisting) {
      await rm(audioBackupPath, { force: true });
    }
    if (jsonHadExisting) {
      await rm(jsonBackupPath, { force: true });
    }
  } catch (error: unknown) {
    if (jsonFinalized) {
      await rm(params.jsonTargetPath, { force: true }).catch(() => undefined);
    }
    if (audioFinalized) {
      await rm(params.audioTargetPath, { force: true }).catch(() => undefined);
    }

    if (audioHadExisting && (await fileExists(audioBackupPath))) {
      await rename(audioBackupPath, params.audioTargetPath).catch(() => undefined);
    }
    if (jsonHadExisting && (await fileExists(jsonBackupPath))) {
      await rename(jsonBackupPath, params.jsonTargetPath).catch(() => undefined);
    }

    await rm(audioTempPath, { force: true }).catch(() => undefined);
    await rm(jsonTempPath, { force: true }).catch(() => undefined);

    throw new Error(`Failed to finalize output files: ${formatError(error)}`);
  }
}

export function buildOutputPayload(params: {
  card: MumblerCard;
  finalProfile: MumblerCard["audioProfile"];
  finalDurationSec: number | null;
  finalizedAtUtc: string;
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    appVersion: app.getVersion(),
    originalFilename: params.card.originalFilename,
    importSource: params.card.importSource,
    timestamps: {
      confirmedLocal: params.card.timestamps.confirmedLocal,
      confirmedUtc: params.card.timestamps.confirmedUtc,
      effectiveLocal: params.card.timestamps.effectiveLocal,
      effectiveUtc: params.card.timestamps.effectiveUtc,
      timezone: params.card.timestamps.timezone,
      transcribedAtUtc: params.card.ai.transcription?.generatedAtUtc ?? null,
      finalizedAtUtc: params.finalizedAtUtc,
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
      title: params.card.metadata.title,
      slug: params.card.metadata.slug,
    },
    providers: {
      transcription: params.card.ai.transcription,
      title: params.card.ai.title,
      slug: params.card.ai.slug,
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
