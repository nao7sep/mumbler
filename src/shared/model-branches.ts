import { ThinkingLevel, type GenerateContentConfig } from "@google/genai";

// The Gemini thinking levels in the provider's own words, which are also the
// thinking values the rows list.
const THINKING_LEVELS: Readonly<Record<string, ThinkingLevel>> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

function thinkingConfig(thinking: string | undefined): GenerateContentConfig {
  return thinking === undefined ? {} : { thinkingConfig: { thinkingLevel: THINKING_LEVELS[thinking] } };
}

// What each supported model needs beyond the plain request, one branch per row of
// SUPPORTED_MODELS; an id with no branch gets undefined and so the plain request,
// model and contents only, with no thinking parameter. A branch translates the
// role's thinking value, one its row lists, into Gemini 3.x's `thinkingLevel`.
// No branch sends an output ceiling. An id is matched trimmed and case-insensitively;
// the request still sends it as stored.
export function supportedModelConfig(id: string, thinking: string | undefined): GenerateContentConfig | undefined {
  switch (id.trim().toLowerCase()) {
    // Thinking from low to high. This model only works in thinking mode and rejects a budget of 0.
    case "gemini-3.1-pro-preview":
      return thinkingConfig(thinking);
    // Thinking from low to high; this model cannot turn thinking off.
    case "gemini-3.8-flash":
      return thinkingConfig(thinking);
    // Thinking from minimal to high; minimal does not guarantee thinking is off.
    case "gemini-3.5-flash-lite":
      return thinkingConfig(thinking);
    default:
      return undefined;
  }
}
