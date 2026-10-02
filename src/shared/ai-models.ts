export type AiProvider = "gemini";
export type ModelKind = "text-smart" | "text-balanced" | "text-fast" | "transcription";
export type AiRole = "transcription" | "outline" | "metadata";
export const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com";

export interface SupportedModel {
  provider: AiProvider;
  id: string;
  kinds: readonly ModelKind[];
  defaultFor: readonly ModelKind[];
  // The thinking values the model accepts, in the provider's own words, ascending.
  thinking: readonly string[];
}

export const SUPPORTED_MODELS: readonly SupportedModel[] = [
  { provider: "gemini", id: "gemini-3.1-pro-preview", kinds: ["text-smart"], defaultFor: ["text-smart"], thinking: ["low", "medium", "high"] },
  { provider: "gemini", id: "gemini-3.8-flash", kinds: ["text-balanced", "transcription"], defaultFor: ["text-balanced", "transcription"], thinking: ["low", "medium", "high"] },
  { provider: "gemini", id: "gemini-3.5-flash-lite", kinds: ["text-fast"], defaultFor: ["text-fast"], thinking: ["minimal", "low", "medium", "high"] },
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

// A fast role thinks as little as the row allows; every other role thinks
// adaptively where the row offers it, else at medium, else at its first value.
export function defaultThinkingFor(row: SupportedModel, role: AiRole): string {
  const definition = AI_ROLES.find(({ id }) => id === role);
  if (definition && "kind" in definition && definition.kind === "text-fast") {
    return row.thinking.find((value) => value === "off" || value === "none") ?? row.thinking[0];
  }
  return ["adaptive", "medium"].find((value) => row.thinking.includes(value)) ?? row.thinking[0];
}

// The value a role sends: its chosen value when the model's row lists it, else the
// role's default for that row; a model with no row sends no thinking value.
export function thinkingFor(model: string, role: AiRole, chosen: string): string | undefined {
  const row = rowFor(model);
  if (!row) return undefined;
  return row.thinking.includes(chosen) ? chosen : defaultThinkingFor(row, role);
}
