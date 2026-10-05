import { HarmBlockThreshold, HarmCategory, ThinkingLevel, type GenerateContentConfig, type SafetySetting } from "@google/genai";

// The Gemini thinking levels in the provider's own words, which are also the
// thinking values the rows list.
const THINKING_LEVELS: Readonly<Record<string, ThinkingLevel>> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

// The most permissive safety values, sent with every listed model and never exposed
// (ai-model-lineup-20261004, Safety).
const SAFETY_SETTINGS: readonly SafetySetting[] = [
  HarmCategory.HARM_CATEGORY_HARASSMENT,
  HarmCategory.HARM_CATEGORY_HATE_SPEECH,
  HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
  HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
  HarmCategory.HARM_CATEGORY_JAILBREAK,
].map((category) => ({ category, threshold: HarmBlockThreshold.OFF }));

function listedConfig(thinking: string | undefined): GenerateContentConfig {
  return {
    safetySettings: [...SAFETY_SETTINGS],
    ...(thinking === undefined ? {} : { thinkingConfig: { thinkingLevel: THINKING_LEVELS[thinking] } }),
  };
}

// What each supported model needs beyond the plain request, one branch per row of
// SUPPORTED_MODELS: the safety settings, and the role's thinking value, one its row
// lists, translated into Gemini 3.x's `thinkingLevel`. No branch sends an output
// ceiling. An id with no branch gets undefined and so the plain request: the model,
// the contents and, for a structured answer, its strict schema, with no thinking and
// no safety settings. An id is matched trimmed and case-insensitively; the request
// still sends it as stored.
export function supportedModelConfig(id: string, thinking: string | undefined): GenerateContentConfig | undefined {
  switch (id.trim().toLowerCase()) {
    // Thinking from low to high. This model only works in thinking mode and rejects a budget of 0.
    case "gemini-3.1-pro-preview":
      return listedConfig(thinking);
    // Thinking from low to high; this model cannot turn thinking off.
    case "gemini-3.8-flash":
      return listedConfig(thinking);
    // Thinking from minimal to high; minimal does not guarantee thinking is off.
    case "gemini-3.5-flash-lite":
      return listedConfig(thinking);
    default:
      return undefined;
  }
}
