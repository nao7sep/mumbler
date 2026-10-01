import { ThinkingLevel, type GenerateContentConfig } from "@google/genai";

// What each supported model needs beyond the plain request, one branch per row of
// SUPPORTED_MODELS; an id with no branch gets undefined and so the plain request,
// model and contents only. Thinking is stated rather than left to the provider,
// whose default differs from model to model; Gemini 3.x takes `thinkingLevel`.
// No branch sends an output ceiling. An id is matched trimmed and case-insensitively;
// the request still sends it as stored.
export function supportedModelConfig(id: string): GenerateContentConfig | undefined {
  switch (id.trim().toLowerCase()) {
    // Medium thinking. This model only works in thinking mode and rejects a budget of 0.
    case "gemini-3.1-pro-preview":
      return { thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM } };
    // Medium thinking; nothing else beyond the plain request.
    case "gemini-3.8-flash":
      return { thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM } };
    // Medium thinking; nothing else beyond the plain request.
    case "gemini-3.5-flash-lite":
      return { thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM } };
    default:
      return undefined;
  }
}
