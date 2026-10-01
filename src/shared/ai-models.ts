export type AiProvider = "gemini";
export type ModelKind = "text-smart" | "text-balanced" | "text-fast" | "transcription";
export type AiRole = "transcription" | "outline" | "metadata";
export const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com";

export interface SupportedModel {
  provider: AiProvider;
  id: string;
  kinds: readonly ModelKind[];
  defaultFor: readonly ModelKind[];
}

export const SUPPORTED_MODELS: readonly SupportedModel[] = [
  { provider: "gemini", id: "gemini-3.1-pro-preview", kinds: ["text-smart"], defaultFor: ["text-smart"] },
  { provider: "gemini", id: "gemini-3.8-flash", kinds: ["text-balanced", "transcription"], defaultFor: ["text-balanced", "transcription"] },
  { provider: "gemini", id: "gemini-3.5-flash-lite", kinds: ["text-fast"], defaultFor: ["text-fast"] },
];

export const AI_ROLES = [
  // Long audio in one call, inline up to 14.25 MB and through the Files API above; only Gemini takes it whole.
  { id: "transcription", provider: "gemini" },
  // Turns the transcript into structured text; balanced reasoning preserves the substance.
  { id: "outline", kind: "text-balanced" },
  // Title and slug are short and formulaic, so the fast tier serves both.
  { id: "metadata", kind: "text-fast" },
] as const;

export function modelsFor(provider: AiProvider, kind: ModelKind): readonly SupportedModel[] {
  return SUPPORTED_MODELS.filter((row) => row.provider === provider && row.kinds.includes(kind));
}

export function defaultModelFor(provider: AiProvider, kind: ModelKind): string {
  const rows = modelsFor(provider, kind);
  const row = rows.find((model) => model.defaultFor.includes(kind)) ?? rows[0];
  if (!row) throw new Error(`No models for ${provider}/${kind}.`);
  return row.id;
}
