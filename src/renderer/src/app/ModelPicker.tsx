import { useId } from "react";
import type { ModelKind } from "@shared/ai-models";
import { modelOptions } from "@shared/model-options";
import { useI18n } from "../i18n/I18nContext";

export function ModelPicker({ label, value, kind, fetched = [], extra = [], disabled = false, onChange }: {
  label: string;
  value: string;
  kind: ModelKind;
  fetched?: readonly string[];
  extra?: readonly string[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const groups = modelOptions(kind, fetched, extra, value);
  return <div className="field">
    <label htmlFor={id}>{label}</label>
    <div className="inline-action-field">
      <input id={id} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
      <select aria-label={t("models.suggestions", { role: label })} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {Object.entries(groups).map(([group, ids]) => ids.length > 0 ? <optgroup key={group} label={t(`models.${group}` as "models.bundled" | "models.provider" | "models.extra" | "models.outOfList")}>
          {ids.map((model) => <option key={model} value={model}>{model}</option>)}
        </optgroup> : null)}
      </select>
    </div>
  </div>;
}
