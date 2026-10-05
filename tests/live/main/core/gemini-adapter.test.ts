// Each supported row's request path through the real Gemini API, one call per
// row and kind with the cheapest input: the 8-second speech clip from the shared
// corpus, sent inline, on every transcription row at its own default thinking;
// then one outline and the title and slug requests on a short fixed transcript,
// each on its role's default model. Run only by npm run test:full, through vitest.live.config.ts. The
// survey settled every parameter value; this lane proves the provider accepts
// each request the adapter builds, the safety settings and strict schemas
// included. The runtime's own end-to-end run lives in app-runtime.test.ts.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { defaultModelFor, modelsFor, rowFor, thinkingFor } from "@shared/ai-models";
import { inferAudioMimeType } from "@main/core/audio-tools";
import { sanitizeSlug } from "@main/core/card-pipeline";
import { generateTextWithGemini, transcribeWithGemini, type RecordProviderCall } from "@main/core/gemini-adapter";
import { createDefaultSettings } from "@main/core/settings-schema";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const CLIP = join(REPO, "..", "company", "assets", "test-fixtures", "audio", "speech", "english-natural-16k-mono.wav");
const CALL_TIMEOUT_MS = 2 * 60_000;
// A short spoken-style transcript, so the text requests need no transcription first.
const TRANSCRIPT = "So the plan for Saturday is simple. We meet at the station at nine, walk up to the lake, and have lunch there before heading back.";
const SAFETY_CATEGORIES = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
  "HARM_CATEGORY_JAILBREAK",
];

function apiKey(): string {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) {
    throw new Error("GEMINI_API_KEY is not set. The full run calls the real Gemini API; export GEMINI_API_KEY and run it again.");
  }
  return key;
}

async function requireClip(): Promise<void> {
  await readFile(CLIP).catch(() => {
    throw new Error(`The live lane reads the shared test-fixture corpus at ${CLIP}; check out the company repository beside this one.`);
  });
}

/** Records every call the adapter makes, so a test can read the request as sent. */
function recorder(): { recordCall: RecordProviderCall; requests: () => Array<{ config?: Record<string, unknown> }> } {
  const calls: Array<Parameters<RecordProviderCall>[0]> = [];
  return {
    recordCall: async (call) => { calls.push(call); },
    requests: () => calls.filter((call) => call.operation === "models.generateContent").map((call) => call.request as { config?: Record<string, unknown> }),
  };
}

function expectSentAsBuilt(config: Record<string, unknown> | undefined, thinking: string): void {
  expect(config?.safetySettings).toEqual(SAFETY_CATEGORIES.map((category) => ({ category, threshold: "OFF" })));
  expect(config?.thinkingConfig).toEqual({ thinkingLevel: thinking.toUpperCase() });
}

describe("each supported Gemini row through the real API", () => {
  it.each(modelsFor("gemini", "transcription").map((row) => [row.id]))(
    "transcribes the short clip on %s at its default thinking",
    async (model) => {
      const key = apiKey();
      await requireClip();
      const thinking = thinkingFor(model, rowFor(model)!.defaultThinking)!;
      const { recordCall, requests } = recorder();

      const result = await transcribeWithGemini({
        apiKey: key,
        filePath: CLIP,
        mimeType: inferAudioMimeType(CLIP),
        model,
        thinking,
        timeoutMs: CALL_TIMEOUT_MS,
        recordCall,
      });

      expect(result.transport).toBe("inline");
      expect(result.text.split(/\s+/).length, result.text).toBeGreaterThan(5);
      expect(requests()).toHaveLength(1);
      expectSentAsBuilt(requests()[0]!.config, thinking);
    },
  );

  it("writes the outline as prose and the title and slug through their strict schemas", async () => {
    const key = apiKey();
    const settings = createDefaultSettings();

    const outlineModel = defaultModelFor("gemini", "text-balanced");
    const metadataModel = defaultModelFor("gemini", "text-fast");
    const outlineThinking = settings["gemini.thinking.outline"];
    const metadataThinking = settings["gemini.thinking.metadata"];
    const { recordCall, requests } = recorder();
    const base = { apiKey: key, timeoutMs: CALL_TIMEOUT_MS, recordCall };

    const outline = await generateTextWithGemini({
      ...base,
      model: outlineModel,
      thinking: outlineThinking,
      prompt: settings.prompts.structured.replaceAll("{transcript}", TRANSCRIPT),
    });
    const title = await generateTextWithGemini({
      ...base,
      model: metadataModel,
      thinking: metadataThinking,
      field: "title",
      prompt: settings.prompts.title.replaceAll("{transcript}", TRANSCRIPT).replaceAll("{structured}", outline.text),
    });
    const slug = await generateTextWithGemini({
      ...base,
      model: metadataModel,
      thinking: metadataThinking,
      field: "slug",
      prompt: settings.prompts.slug.replaceAll("{title}", title.text),
    });

    expect(outline.text.trim()).toBeTruthy();
    expect(title.text, "the title is the field's value, not the JSON around it").not.toMatch(/^\s*\{/);
    expect(sanitizeSlug(slug.text), slug.text).toBeTruthy();
    const [outlineRequest, titleRequest, slugRequest] = requests();
    expectSentAsBuilt(outlineRequest!.config, outlineThinking);
    expect(outlineRequest!.config).not.toHaveProperty("responseSchema");
    expectSentAsBuilt(titleRequest!.config, metadataThinking);
    expect(titleRequest!.config?.responseMimeType).toBe("application/json");
    expectSentAsBuilt(slugRequest!.config, metadataThinking);
    expect(slugRequest!.config?.responseMimeType).toBe("application/json");
  });
});
