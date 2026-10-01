import type { GenerateContentConfig } from "@google/genai";

import type { AiRole } from "./ai-models";

interface FamilyPolicy {
  thinkingConfig?: { thinkingLevel: "medium" } | { thinkingBudget: -1 };
  maxOutputTokens: boolean;
}
interface ModelFamily {
  id: string;
  adapter: "gemini.generateContent";
  generic: boolean;
  policy: FamilyPolicy;
}
export const MODEL_FAMILIES: Readonly<Record<string, ModelFamily>> = {
  gemini3: { id: "gemini3", adapter: "gemini.generateContent", generic: false, policy: { thinkingConfig: { thinkingLevel: "medium" }, maxOutputTokens: true } },
  gemini25: { id: "gemini25", adapter: "gemini.generateContent", generic: false, policy: { thinkingConfig: { thinkingBudget: -1 }, maxOutputTokens: true } },
  gemini: { id: "gemini", adapter: "gemini.generateContent", generic: false, policy: { maxOutputTokens: true } },
  generic: { id: "generic", adapter: "gemini.generateContent", generic: true, policy: { maxOutputTokens: true } },
};
export const MODEL_RULES = [
  { pattern: /^gemini-3/, family: "gemini3" },
  { pattern: /^gemini-2\.5-/, family: "gemini25" },
  { pattern: /^gemini-/, family: "gemini" },
] as const;
// Gemini currently has no exact-id policy exceptions.
export const MODEL_EXCEPTIONS: Readonly<Record<string, Partial<FamilyPolicy>>> = {};

export function resolveModel(id: string): ModelFamily {
  const family = MODEL_FAMILIES[MODEL_RULES.find((rule) => rule.pattern.test(id))?.family ?? "generic"]!;
  const exception = MODEL_EXCEPTIONS[id];
  return exception ? { ...family, policy: { ...family.policy, ...exception } } : family;
}

// The SDK types `thinkingLevel` as its own enum, whose values are upper case; the
// policy sends the lower-case value, so the result is asserted to the SDK's type.
export function generationPolicy(id: string, role: AiRole): GenerateContentConfig {
  const { policy } = resolveModel(id);
  return {
    ...(policy.thinkingConfig ? { thinkingConfig: policy.thinkingConfig } : {}),
    ...(policy.maxOutputTokens ? { maxOutputTokens: role === "metadata" ? 1024 : 65536 } : {}),
  } as GenerateContentConfig;
}
