import { describe, expect, it } from "vitest";
import { AI_ROLES, MODEL_LINEUP, SUPPORTED_MODELS, defaultModelFor, isSupportedModel, modelsFor, thinkingAfterModelEdit, thinkingFor, type ModelKind } from "@shared/ai-models";
import { ThinkingLevel } from "@google/genai";
import { supportedModelConfig } from "@shared/model-branches";
import { createDefaultSettings, buildSettingsDraft } from "@main/core/settings-schema";

describe("the model registry and committed lineup", () => {
  it("rests on the 2026-10-04 lineup, its rows from the highest tier to the lowest", () => {
    expect(MODEL_LINEUP).toBe("ai-model-lineup-20261004");
    expect(SUPPORTED_MODELS).toEqual([
      { provider: "gemini", id: "gemini-3.1-pro-preview", kinds: ["text-smart", "transcription"], defaultFor: ["text-smart"], thinking: ["low", "medium", "high"], defaultThinking: "medium" },
      { provider: "gemini", id: "gemini-3.8-flash", kinds: ["text-balanced", "transcription"], defaultFor: ["text-balanced", "transcription"], thinking: ["low", "medium", "high"], defaultThinking: "medium" },
      { provider: "gemini", id: "gemini-3.5-flash-lite", kinds: ["text-fast", "transcription"], defaultFor: ["text-fast"], thinking: ["minimal", "low", "medium", "high"], defaultThinking: "minimal" },
    ]);
    expect(AI_ROLES).toEqual([
      { id: "transcription", provider: "gemini" },
      { id: "outline", kind: "text-balanced" },
      { id: "metadata", kind: "text-fast" },
    ]);
    expect(modelsFor("gemini", "transcription").map((row) => row.id)).toEqual(["gemini-3.1-pro-preview", "gemini-3.8-flash", "gemini-3.5-flash-lite"]);
    expect(defaultModelFor("gemini", "transcription")).toBe("gemini-3.8-flash");
    expect(defaultModelFor("gemini", "text-balanced")).toBe("gemini-3.8-flash");
    expect(defaultModelFor("gemini", "text-fast")).toBe("gemini-3.5-flash-lite");
    expect(defaultModelFor("gemini", "text-smart")).toBe("gemini-3.1-pro-preview");
  });

  it("keeps every approved row, each with its own branch, and gives any other id the plain request", () => {
    expect(SUPPORTED_MODELS.map((row) => row.id)).toEqual(["gemini-3.1-pro-preview", "gemini-3.8-flash", "gemini-3.5-flash-lite"]);
    const levels = new Set<string>(Object.values(ThinkingLevel));
    for (const row of SUPPORTED_MODELS) {
      expect(row.thinking.length, row.id).toBeGreaterThan(0);
      for (const value of row.thinking) {
        const config = supportedModelConfig(row.id, value);
        const level = config?.thinkingConfig?.thinkingLevel;
        expect(level, `${row.id} ${value}`).toBe(value.toUpperCase());
        expect(levels.has(level!), `${row.id} ${value}`).toBe(true);
        expect(config?.safetySettings?.map((setting) => setting.threshold), row.id).toEqual(["OFF", "OFF", "OFF", "OFF", "OFF"]);
      }
    }
    expect(supportedModelConfig(" GEMINI-3.8-FLASH ", "high")).toEqual(supportedModelConfig("gemini-3.8-flash", "high"));
    for (const id of ["gemini-3.9-flash", "gemini-2.5-pro", "custom-model"]) {
      expect(supportedModelConfig(id, thinkingFor(id, "high")), id).toBeUndefined();
    }
  });

  it("defaults thinking by the model's own tier, whatever the role, and sends only a value the row lists", () => {
    expect(thinkingFor("gemini-3.1-pro-preview", "")).toBe("medium");
    expect(thinkingFor("gemini-3.8-flash", "")).toBe("medium");
    expect(thinkingFor(" GEMINI-3.5-FLASH-LITE ", "")).toBe("minimal");
    expect(thinkingFor("gemini-3.8-flash", "high")).toBe("high");
    expect(thinkingFor("gemini-3.8-flash", "minimal")).toBe("medium");
    expect(thinkingFor("gemini-3.5-flash-lite", "minimal")).toBe("minimal");
    expect(thinkingFor("custom-model", "high")).toBeUndefined();
    const settings = createDefaultSettings();
    expect([settings["gemini.thinking.transcription"], settings["gemini.thinking.outline"], settings["gemini.thinking.metadata"]]).toEqual(["medium", "medium", "minimal"]);
  });

  it("resets thinking on a model edit only when it reaches a different listed row than the last one the field held", () => {
    const edit = (lastListed: string, next: string, chosen: string) => thinkingAfterModelEdit(lastListed, next, chosen);
    // The same row, however it is spaced, cased or retyped, keeps the choice.
    expect(edit("gemini-3.8-flash", "gemini-3.8-flash ", "high")).toEqual({ thinking: "high", lastListedModel: "gemini-3.8-flash " });
    expect(edit("gemini-3.8-flash", " GEMINI-3.8-Flash", "high").thinking).toBe("high");
    // A different row starts at that row's own default.
    expect(edit("gemini-3.8-flash", "gemini-3.5-flash-lite", "high")).toEqual({ thinking: "minimal", lastListedModel: "gemini-3.5-flash-lite" });
    expect(edit("gemini-3.5-flash-lite", "gemini-3.1-pro-preview", "high").thinking).toBe("medium");
    // An unlisted id keeps the value and the last listed id.
    expect(edit("gemini-3.8-flash", "gemini-3.8-flas", "high")).toEqual({ thinking: "high", lastListedModel: "gemini-3.8-flash" });
    expect(edit("gemini-3.8-flash", "custom-model", "high")).toEqual({ thinking: "high", lastListedModel: "gemini-3.8-flash" });
    // A field that has held no row keeps the value at the first row it reaches when that row lists it.
    expect(edit("custom-model", "gemini-3.5-flash-lite", "high")).toEqual({ thinking: "high", lastListedModel: "gemini-3.5-flash-lite" });
    expect(edit("custom-model", "gemini-3.8-flash", "minimal")).toEqual({ thinking: "medium", lastListedModel: "gemini-3.8-flash" });
  });

  it("keeps the choice when a letter of the id is deleted and retyped, and resets it on reaching another row", () => {
    let state = { thinking: "high", lastListedModel: "gemini-3.8-flash" };
    for (const typed of ["gemini-3.8-flas", "gemini-3.8-fla", "gemini-3.8-flas", "gemini-3.8-flash"]) {
      state = thinkingAfterModelEdit(state.lastListedModel, typed, state.thinking);
    }
    expect(state).toEqual({ thinking: "high", lastListedModel: "gemini-3.8-flash" });
    for (const typed of ["gemini-3.8-", "gemini-3.", "gemini-3.5-flash-lite"]) {
      state = thinkingAfterModelEdit(state.lastListedModel, typed, state.thinking);
    }
    expect(state).toEqual({ thinking: "minimal", lastListedModel: "gemini-3.5-flash-lite" });
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
