import { describe, expect, it } from "vitest";
import { AI_ROLES, SUPPORTED_MODELS, defaultModelFor, defaultThinkingFor, isSupportedModel, modelsFor, rowFor, thinkingFor, type ModelKind } from "@shared/ai-models";
import { ThinkingLevel } from "@google/genai";
import { supportedModelConfig } from "@shared/model-branches";
import { createDefaultSettings, buildSettingsDraft } from "@main/core/settings-schema";

describe("the model registry and committed lineup", () => {
  it("keeps every approved row, each with its own branch, and gives any other id the plain request", () => {
    expect(SUPPORTED_MODELS.map((row) => row.id)).toEqual(["gemini-3.1-pro-preview", "gemini-3.8-flash", "gemini-3.5-flash-lite"]);
    const levels = new Set<string>(Object.values(ThinkingLevel));
    for (const row of SUPPORTED_MODELS) {
      expect(row.thinking.length, row.id).toBeGreaterThan(0);
      for (const value of row.thinking) {
        const level = supportedModelConfig(row.id, value)?.thinkingConfig?.thinkingLevel;
        expect(level, `${row.id} ${value}`).toBe(value.toUpperCase());
        expect(levels.has(level!), `${row.id} ${value}`).toBe(true);
      }
    }
    expect(supportedModelConfig(" GEMINI-3.8-FLASH ", "high")).toEqual(supportedModelConfig("gemini-3.8-flash", "high"));
    for (const id of ["gemini-3.9-flash", "gemini-2.5-pro", "custom-model"]) {
      expect(supportedModelConfig(id, thinkingFor(id, "outline", "high")), id).toBeUndefined();
    }
  });

  it("defaults each role's thinking by its tier and sends only a value the row lists", () => {
    expect(SUPPORTED_MODELS.map((row) => [row.id, row.thinking])).toEqual([
      ["gemini-3.1-pro-preview", ["low", "medium", "high"]],
      ["gemini-3.8-flash", ["low", "medium", "high"]],
      ["gemini-3.5-flash-lite", ["minimal", "low", "medium", "high"]],
    ]);
    const flash = rowFor("gemini-3.8-flash")!;
    const lite = rowFor(" GEMINI-3.5-FLASH-LITE ")!;
    expect(defaultThinkingFor(flash, "transcription")).toBe("medium");
    expect(defaultThinkingFor(flash, "outline")).toBe("medium");
    expect(defaultThinkingFor(flash, "metadata")).toBe("low");
    expect(defaultThinkingFor(lite, "metadata")).toBe("minimal");
    expect(defaultThinkingFor(lite, "outline")).toBe("medium");
    expect(thinkingFor("gemini-3.8-flash", "outline", "high")).toBe("high");
    expect(thinkingFor("gemini-3.8-flash", "outline", "minimal")).toBe("medium");
    expect(thinkingFor("custom-model", "outline", "high")).toBeUndefined();
  });

  it("has exactly one default for every offered kind and a selection field for every role", () => {
    const kinds = new Set(SUPPORTED_MODELS.flatMap((row) => [...row.kinds]));
    for (const kind of kinds) {
      const rows = modelsFor("gemini", kind);
      expect(rows.filter((row) => row.defaultFor.includes(kind))).toHaveLength(1);
      expect(rows.map((row) => row.id)).toContain(defaultModelFor("gemini", kind));
    }
    const settings = createDefaultSettings();
    const draft = buildSettingsDraft(settings, "", "", false);
    for (const role of AI_ROLES) {
      const kind: ModelKind = "kind" in role ? role.kind : "transcription";
      expect(modelsFor("gemini", kind).length).toBeGreaterThan(0);
      expect(settings[`gemini.${role.id}`]).toBe(defaultModelFor("gemini", kind));
      expect(draft[`${role.id}Model`]).toBe(settings[`gemini.${role.id}`]);
    }
  });

  it("recognises a supported model id trimmed and case-insensitively", () => {
    expect(isSupportedModel(" GEMINI-3.8-FLASH ")).toBe(true);
    expect(isSupportedModel("gemini-2.5-pro")).toBe(false);
    expect(isSupportedModel("")).toBe(false);
  });
});
