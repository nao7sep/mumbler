import { describe, expect, it } from "vitest";
import { AI_ROLES, SUPPORTED_MODELS, defaultModelFor, modelsFor, type ModelKind } from "@shared/ai-models";
import { MODEL_EXCEPTIONS, generationPolicy, resolveModel } from "@shared/model-registry";
import { createDefaultSettings, buildSettingsDraft } from "@main/core/settings-schema";
import { modelOptions } from "@shared/model-options";

describe("the model registry and committed lineup", () => {
  it("keeps every approved row and a non-generic family for each", () => {
    expect(SUPPORTED_MODELS.map((row) => row.id)).toEqual(["gemini-3.1-pro-preview", "gemini-3.8-flash", "gemini-3.5-flash-lite"]);
    for (const row of SUPPORTED_MODELS) expect(resolveModel(row.id).generic).toBe(false);
    expect(resolveModel("nonsense").generic).toBe(true);
    expect(MODEL_EXCEPTIONS).toEqual({});
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
    expect(settings.extraModelIds).toEqual({ gemini: [] });
  });

  it("resolves future ids by family and builds only declared parameters", () => {
    for (const id of ["gemini-3.9-flash", "gemini-2.5-pro", "gemini-next", "custom-model"]) {
      const family = resolveModel(id);
      const policy = generationPolicy(id, "outline");
      expect(policy).not.toHaveProperty("temperature");
      expect(Object.keys(policy).every((key) => Object.hasOwn(family.policy, key))).toBe(true);
      expect(policy.maxOutputTokens).toBe(65536);
    }
    expect(generationPolicy("gemini-3.8-flash", "metadata")).toEqual({ thinkingConfig: { thinkingLevel: "medium" }, maxOutputTokens: 1024 });
    expect(generationPolicy("gemini-2.5-flash", "transcription")).toEqual({ thinkingConfig: { thinkingBudget: -1 }, maxOutputTokens: 65536 });
    expect(generationPolicy("custom-model", "metadata")).toEqual({ maxOutputTokens: 1024 });
  });

  it("groups and deduplicates suggestions while retaining an out-of-list selection", () => {
    expect(modelOptions("text-balanced", ["gemini-3.8-flash", "gemini-future"], ["gemini-future", "custom"], "orphan")).toEqual({
      bundled: ["gemini-3.8-flash"], provider: ["gemini-future"], extra: ["custom"], outOfList: ["orphan"],
    });
  });
});
