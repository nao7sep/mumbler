export type AiProvider = "gemini";
export type ModelKind = "text-smart" | "text-balanced" | "text-fast" | "transcription";
export type AiRole = "transcription" | "outline" | "metadata";
export const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com";

// The lineup research these rows and defaults rest on.
export const MODEL_LINEUP = "ai-model-lineup-20261004";

export interface SupportedModel {
  provider: AiProvider;
  id: string;
  kinds: readonly ModelKind[];
  defaultFor: readonly ModelKind[];
  // The thinking values the model accepts, in the provider's own words, ascending.
  thinking: readonly string[];
  // The value a role's Thinking field starts at with this model, set by the model's own tier.
  defaultThinking: string;
}

// Highest tier first; each row's default thinking follows its own tier
// (ai-model-routing-conventions, Thinking).
export const SUPPORTED_MODELS: readonly SupportedModel[] = [
  { provider: "gemini", id: "gemini-3.1-pro-preview", kinds: ["text-smart", "transcription"], defaultFor: ["text-smart"], thinking: ["low", "medium", "high"], defaultThinking: "medium" },
  { provider: "gemini", id: "gemini-3.8-flash", kinds: ["text-balanced", "transcription"], defaultFor: ["text-balanced", "transcription"], thinking: ["low", "medium", "high"], defaultThinking: "medium" },
  { provider: "gemini", id: "gemini-3.5-flash-lite", kinds: ["text-fast", "transcription"], defaultFor: ["text-fast"], thinking: ["minimal", "low", "medium", "high"], defaultThinking: "minimal" },
];

export const AI_ROLES = [
  // Long audio in one call, inline up to 14.25 MB and through the Files API above; only Gemini takes it whole.
  { id: "transcription", provider: "gemini" },
  // Turns the transcript into structured text; balanced reasoning preserves the substance.
  { id: "outline", kind: "text-balanced" },
  // Title and slug are short and formulaic, so the fast tier serves both.
  { id: "metadata", kind: "text-fast" },
] as const;

// A model id is its own key, matched trimmed and case-insensitively.
export function rowFor(id: string): SupportedModel | undefined {
  const key = id.trim().toLowerCase();
  return SUPPORTED_MODELS.find((row) => row.id === key);
}

export function isSupportedModel(id: string): boolean {
  return rowFor(id) !== undefined;
}

export function modelsFor(provider: AiProvider, kind: ModelKind): readonly SupportedModel[] {
  return SUPPORTED_MODELS.filter((row) => row.provider === provider && row.kinds.includes(kind));
}

export function defaultModelFor(provider: AiProvider, kind: ModelKind): string {
  const rows = modelsFor(provider, kind);
  const row = rows.find((model) => model.defaultFor.includes(kind)) ?? rows[0];
  if (!row) throw new Error(`No models for ${provider}/${kind}.`);
  return row.id;
}

// The value a role sends: its chosen value when the model's row lists it, else that
// row's default; a model with no row sends no thinking value.
export function thinkingFor(model: string, chosen: string): string | undefined {
  const row = rowFor(model);
  if (!row) return undefined;
  return row.thinking.includes(chosen) ? chosen : row.defaultThinking;
}

// A model field edit: the Thinking value it leaves, and the last listed id the field
// has held. The value starts at the new row's default only when the edit reaches a
// different row than that last listed one; an id with no row, passed through while
// typing or landed on, keeps both, so the choice stays stored, hidden and unsent,
// and returning to the same row keeps it. A field that opens on an unlisted id has
// held no row yet, so the first row it reaches sets its default.
export function thinkingAfterModelEdit(
  lastListedModel: string,
  nextModel: string,
  chosen: string,
): { thinking: string; lastListedModel: string } {
  const next = rowFor(nextModel);
  if (!next) return { thinking: chosen, lastListedModel };
  return { thinking: next === rowFor(lastListedModel) ? chosen : next.defaultThinking, lastListedModel: nextModel };
}
