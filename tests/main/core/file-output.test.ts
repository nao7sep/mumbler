import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MumblerCard } from "@shared/app-shell";

// buildOutputPayload reads app.getVersion(); stub electron so the module loads
// and that one field is deterministic under the node test environment.
vi.mock("electron", () => ({ app: { getVersion: () => "9.9.9-test" } }));

const {
  buildMarkdownContent,
  buildOutputPayload,
  computeFinalDuration,
  finalizeOutputsAtomically,
  yamlDoubleQuotedString,
} = await import("@main/core/file-output");
const { fileExists } = await import("@main/core/file-io");

function makeCard(overrides: Partial<MumblerCard> = {}): MumblerCard {
  return {
    id: "card-1",
    originalFilename: "rec.m4a",
    importSource: "file-picker",
    sourceFilePath: "/tmp/rec.m4a",
    audioProfile: null,
    durationSec: 60,
    fileSizeBytes: 1024,
    timestamps: {
      confirmedLocal: "2026-04-22 09:44:00",
      confirmedUtc: Date.UTC(2026, 3, 22, 0, 44, 0),
      timezone: "Asia/Tokyo",
      frontTrimOffsetSec: 0,
      effectiveLocal: "2026-04-22 09:44:00",
      effectiveUtc: Date.UTC(2026, 3, 22, 0, 44, 0),
    },
    trim: { frontMarkerSec: null, backMarkerSec: null },
    trimDecision: null,
    transcription: { text: "raw text" },
    metadata: { structured: "## Outline\n\nBody.", title: "My Title", slug: "my-slug" },
    ai: {
      transcription: { provider: "gemini", model: "m", generatedAtUtc: Date.UTC(2026, 3, 22, 1, 0, 0) },
      structured: null,
      title: null,
      slug: null,
    },
    status: "Ready to Save",
    activeStep: null,
    queuedMode: null,
    queuedAtUtc: null,
    lastError: null,
    createdAtUtc: 1,
    updatedAtUtc: 1,
    ...overrides,
  };
}

describe("yamlDoubleQuotedString", () => {
  it("wraps plain values in double quotes", () => {
    expect(yamlDoubleQuotedString("hello")).toBe('"hello"');
  });

  it("escapes embedded double quotes", () => {
    expect(yamlDoubleQuotedString('he said "hi"')).toBe('"he said \\"hi\\""');
  });

  it("escapes backslashes", () => {
    expect(yamlDoubleQuotedString("a\\b")).toBe('"a\\\\b"');
  });

  it("escapes newlines as \\n", () => {
    expect(yamlDoubleQuotedString("line1\nline2")).toBe('"line1\\nline2"');
    expect(yamlDoubleQuotedString("line1\r\nline2")).toBe('"line1\\nline2"');
  });
});

describe("buildMarkdownContent", () => {
  it("produces YAML front matter followed by the structured body", () => {
    const content = buildMarkdownContent({
      card: makeCard(),
      audioFilename: "20260422-004400-my-slug.m4a",
      finalDurationSec: 42,
    });

    expect(content).toBe(
      [
        "---",
        "schema_version: 1",
        'date: "2026-04-22T00:44:00.000Z"',
        'audio: "20260422-004400-my-slug.m4a"',
        "duration: 42",
        'title: "My Title"',
        'slug: "my-slug"',
        "---",
        "",
        "## Outline\n\nBody.",
        "",
      ].join("\n"),
    );
    expect(content.endsWith("\n")).toBe(true);
  });

  it("emits a literal null for an unknown duration and quotes a title with quotes", () => {
    const content = buildMarkdownContent({
      card: makeCard({ metadata: { structured: "", title: 'A "quoted" title', slug: "s" } }),
      audioFilename: "a.m4a",
      finalDurationSec: null,
    });
    expect(content).toContain("duration: null");
    expect(content).toContain('title: "A \\"quoted\\" title"');
  });
});

describe("computeFinalDuration", () => {
  it("prefers a probed duration when available", () => {
    expect(computeFinalDuration(makeCard(), 33.5)).toBe(33.5);
  });

  it("returns null when neither probe nor original duration is known", () => {
    expect(computeFinalDuration(makeCard({ durationSec: null }), null)).toBeNull();
  });

  it("derives duration from trim markers when not probed", () => {
    const card = makeCard({
      durationSec: 30,
      trim: { frontMarkerSec: 5, backMarkerSec: 20 },
    });
    expect(computeFinalDuration(card, null)).toBe(15);
  });

  it("treats a missing back marker as the original end", () => {
    const card = makeCard({ durationSec: 30, trim: { frontMarkerSec: 10, backMarkerSec: null } });
    expect(computeFinalDuration(card, null)).toBe(20);
  });
});

describe("buildOutputPayload", () => {
  it("emits a schema-versioned payload with formatted timestamps and transcription", () => {
    const payload = buildOutputPayload({
      card: makeCard(),
      finalProfile: makeCard().audioProfile,
      finalDurationSec: 42,
      finalizedAtUtc: Date.UTC(2026, 3, 22, 2, 0, 0),
    });

    expect(payload.schemaVersion).toBe(1);
    expect(payload.appVersion).toBe("9.9.9-test");
    expect(payload.transcription).toEqual({
      raw: "raw text",
      structured: "## Outline\n\nBody.",
      title: "My Title",
      slug: "my-slug",
    });
    expect((payload.timestamps as Record<string, unknown>).finalizedAtUtc).toBe(
      "2026-04-22T02:00:00.000Z",
    );
  });

  it("omits the trim block when no markers are set", () => {
    const payload = buildOutputPayload({
      card: makeCard(),
      finalProfile: null,
      finalDurationSec: null,
      finalizedAtUtc: 0,
    });
    expect(payload.trim).toBeNull();
  });
});

describe("finalizeOutputsAtomically", () => {
  let dir: string;
  let sourceAudio: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mumbler-out-"));
    sourceAudio = join(dir, "source.m4a");
    await writeFile(sourceAudio, "AUDIO-BYTES");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function targets(base: string) {
    return {
      audioPath: join(dir, `${base}.m4a`),
      jsonPath: join(dir, `${base}.json`),
      markdownPath: join(dir, `${base}.md`),
    };
  }

  async function leftoverTempsAndBackups(): Promise<string[]> {
    return (await readdir(dir)).filter((name) => name.includes(".tmp") || name.includes(".bak"));
  }

  it("writes all three outputs and leaves no temp or backup files behind", async () => {
    const t = targets("out");
    await finalizeOutputsAtomically({
      sourceAudioPath: sourceAudio,
      targets: t,
      overwrite: false,
      jsonContent: '{"k":1}',
      markdownContent: "# md",
    });

    expect(await readFile(t.audioPath, "utf8")).toBe("AUDIO-BYTES");
    expect(await readFile(t.jsonPath, "utf8")).toBe('{"k":1}');
    expect(await readFile(t.markdownPath, "utf8")).toBe("# md");
    expect(await leftoverTempsAndBackups()).toEqual([]);
  });

  it("overwrites existing outputs and cleans up the backups", async () => {
    const t = targets("out");
    await writeFile(t.audioPath, "OLD-AUDIO");
    await writeFile(t.jsonPath, "OLD-JSON");
    await writeFile(t.markdownPath, "OLD-MD");

    await finalizeOutputsAtomically({
      sourceAudioPath: sourceAudio,
      targets: t,
      overwrite: true,
      jsonContent: "NEW-JSON",
      markdownContent: "NEW-MD",
    });

    expect(await readFile(t.audioPath, "utf8")).toBe("AUDIO-BYTES");
    expect(await readFile(t.jsonPath, "utf8")).toBe("NEW-JSON");
    expect(await readFile(t.markdownPath, "utf8")).toBe("NEW-MD");
    expect(await leftoverTempsAndBackups()).toEqual([]);
  });

  it("rolls back already-finalized outputs and clears temp files when a rename fails", async () => {
    const t = targets("out");
    // Make the markdown target an existing directory: its rename fails only
    // after the audio and json renames have already committed, exercising the
    // rollback path. (overwrite:false, so there are no backups to restore.)
    await mkdir(t.markdownPath);

    await expect(
      finalizeOutputsAtomically({
        sourceAudioPath: sourceAudio,
        targets: t,
        overwrite: false,
        jsonContent: "J",
        markdownContent: "M",
      }),
    ).rejects.toThrow(/finalize/i);

    // A failed save must not leave the audio or json half-committed.
    expect(await fileExists(t.audioPath)).toBe(false);
    expect(await fileExists(t.jsonPath)).toBe(false);
    expect(await leftoverTempsAndBackups()).toEqual([]);
  });
});
