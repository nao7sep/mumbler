import { modelsFor, type ModelKind } from "./ai-models";

export function modelOptions(kind: ModelKind, fetched: readonly string[], extra: readonly string[], selected: string) {
  const seen = new Set<string>();
  const unique = (ids: readonly string[]) => ids.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const bundled = unique(modelsFor("gemini", kind).map((row) => row.id));
  const provider = unique(fetched);
  const authored = unique(extra);
  return { bundled, provider, extra: authored, outOfList: selected && !seen.has(selected) ? [selected] : [] };
}
