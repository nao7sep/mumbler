import type { ReactElement } from "react";

import type { SettingsSummary } from "@shared/app-shell";
import { useI18n } from "../i18n/I18nContext";

// The models the next run uses, as configured in Settings; they are changed there.
export function ConfiguredModels({ summary }: { summary: SettingsSummary | null }): ReactElement {
  const { t } = useI18n();
  return (
    <dl className="meta-list">
      <div>
        <dt>{t("options.transcriptionModel")}</dt>
        <dd>{summary?.transcriptionModel ?? ""}</dd>
      </div>
      <div>
        <dt>{t("options.structuredTranscriptionModel")}</dt>
        <dd>{summary?.outlineModel ?? ""}</dd>
      </div>
      <div>
        <dt>{t("options.metadataModel")}</dt>
        <dd>{summary?.metadataModel ?? ""}</dd>
      </div>
    </dl>
  );
}
