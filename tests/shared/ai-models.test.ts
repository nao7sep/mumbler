import { describe, expect, it } from "vitest";
import { AI_ROLES, SUPPORTED_MODELS, defaultModelFor, isSupportedModel, modelsFor, thinkingAfterModelEdit, thinkingFor, type ModelKind } from "@shared/ai-models";
import { ThinkingLevel } from "@google/genai";
import { supportedModelConfig } from "@shared/model-branches";
import { createDefaultSettings, buildSettingsDraft } from "@main/core/settings-schema";

// The guard test: the table against the code that uses it. The table's own
// values (its rows, their order, lists and defaults) come from the lineup
// research and are reviewed when the table changes, so nothing here restates them.
describe("the model table and the code that uses it", () => {
  // Two rows, the second with a default of its own, so a reset shows.
  const first = SUPPORTED_MODELS[0];
  const second = SUPPORTED_MODELS.find((row) => row.defaultThinking !== first?.defaultThinking) ?? SUPPORTED_MODELS[1];
  const spaced = (id: string) => ` ${id.toUpperCase()} `;

  it("gives every row its branch, translating every thinking value it lists, and any other id the plain request", () => {
    const levels = new Set<string>(Object.values(ThinkingLevel));
    for (const row of SUPPORTED_MODELS) {
      expect(row.thinking.length, row.id).toBeGreaterThan(0);
      expect(row.thinking, row.id).toContain(row.defaultThinking);
      for (const value of row.thinking) {
        const level = supportedModelConfig(row.id, value)?.thinkingConfig?.thinkingLevel;
        expect(level, `${row.id} ${value}`).toBe(value.toUpperCase());
        expect(levels.has(level!), `${row.id} ${value}`).toBe(true);
      }
      expect(supportedModelConfig(spaced(row.id), row.defaultThinking)).toEqual(supportedModelConfig(row.id, row.defaultThinking));
    }
    for (const id of ["gemini-0.0-unknown", "custom-model"]) {
      expect(supportedModelConfig(id, thinkingFor(id, "high")), id).toBeUndefined();
    }
  });

  it("defaults thinking to the row's own default, whatever the role, and sends only a value the row lists", () => {
    for (const row of SUPPORTED_MODELS) {
      expect(thinkingFor(spaced(row.id), ""), row.id).toBe(row.defaultThinking);
      for (const value of row.thinking) expect(thinkingFor(row.id, value)).toBe(value);
      expect(thinkingFor(row.id, "not-a-level")).toBe(row.defaultThinking);
    }
    expect(thinkingFor("custom-model", "high")).toBeUndefined();
    const settings = createDefaultSettings();
    for (const role of AI_ROLES) {
      expect(settings[`gemini.thinking.${role.id}`], role.id).toBe(thinkingFor(settings[`gemini.${role.id}`], ""));
    }
  });

  it("resets thinking on a model edit only when it reaches a different listed row than the last one the field held", () => {
    const kept = first!.thinking.find((value) => value !== first!.defaultThinking) ?? first!.defaultThinking;
    // The same row, however it is spaced, cased or retyped, keeps the choice.
    expect(thinkingAfterModelEdit(first!.id, `${first!.id} `, kept)).toEqual({ thinking: kept, lastListedModel: `${first!.id} ` });
    expect(thinkingAfterModelEdit(first!.id, spaced(first!.id), kept).thinking).toBe(kept);
    // A different row starts at that row's own default.
    expect(thinkingAfterModelEdit(first!.id, second!.id, kept)).toEqual({ thinking: second!.defaultThinking, lastListedModel: second!.id });
    // An unlisted id keeps the value and the last listed id.
    expect(thinkingAfterModelEdit(first!.id, first!.id.slice(0, -1), kept)).toEqual({ thinking: kept, lastListedModel: first!.id });
    expect(thinkingAfterModelEdit(first!.id, "custom-model", kept)).toEqual({ thinking: kept, lastListedModel: first!.id });
    // A field that has held no row keeps the value at the first row it reaches when that row lists it.
    expect(thinkingAfterModelEdit("custom-model", first!.id, kept)).toEqual({ thinking: kept, lastListedModel: first!.id });
    expect(thinkingAfterModelEdit("custom-model", first!.id, "not-a-level")).toEqual({ thinking: first!.defaultThinking, lastListedModel: first!.id });
  });

  it("keeps the choice when a letter of the id is deleted and retyped, and resets it on reaching another row", () => {
    const kept = first!.thinking.find((value) => value !== first!.defaultThinking) ?? first!.defaultThinking;
    let state = { thinking: kept, lastListedModel: first!.id };
    for (const typed of [first!.id.slice(0, -1), first!.id.slice(0, -2), first!.id.slice(0, -1), first!.id]) {
      state = thinkingAfterModelEdit(state.lastListedModel, typed, state.thinking);
    }
    expect(state).toEqual({ thinking: kept, lastListedModel: first!.id });
    state = thinkingAfterModelEdit(state.lastListedModel, second!.id, state.thinking);
    expect(state).toEqual({ thinking: second!.defaultThinking, lastListedModel: second!.id });
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
    for (const row of SUPPORTED_MODELS) expect(isSupportedModel(spaced(row.id)), row.id).toBe(true);
    expect(isSupportedModel("custom-model")).toBe(false);
    expect(isSupportedModel("")).toBe(false);
  });
});
