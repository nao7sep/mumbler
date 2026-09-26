import type { ReactElement } from "react";

import type { MessageKey } from "@shared/i18n/catalogues";
import type { Message } from "@shared/i18n/translate";

import { DecisionModal } from "./DecisionModal";
import { useI18n } from "../i18n/I18nContext";

// The concrete confirm/alert surfaces, each a named wrapper over the generic
// DecisionModal so it is findable by name (and greppable) rather than living as
// anonymous inline JSX in App.tsx. Each owns its title, action labels/variants,
// and safe-dismiss wiring; dynamic text and handlers arrive as props, dynamic
// text as messages rendered here in the interface language.

export function DiscardSettingsModal({
  onKeepEditing,
  onDiscard,
}: {
  onKeepEditing: () => void;
  onDiscard: () => void;
}): ReactElement {
  const { t } = useI18n();
  return (
    <DecisionModal
      title={t("decision.discardTitle")}
      body={t("decision.discardSettingsBody")}
      actions={[
        { label: t("decision.keepEditing"), onClick: onKeepEditing },
        { label: t("decision.discard"), variant: "danger", onClick: onDiscard },
      ]}
      onRequestClose={onKeepEditing}
    />
  );
}

export function DiscardReviewModal({
  onKeepEditing,
  onDiscard,
}: {
  onKeepEditing: () => void;
  onDiscard: () => void;
}): ReactElement {
  const { t } = useI18n();
  return (
    <DecisionModal
      title={t("decision.discardTitle")}
      body={t("decision.discardReviewBody")}
      actions={[
        { label: t("decision.keepEditing"), onClick: onKeepEditing },
        { label: t("decision.discard"), variant: "danger", onClick: onDiscard },
      ]}
      onRequestClose={onKeepEditing}
    />
  );
}

export function SaveConflictModal({
  audioPath,
  jsonPath,
  markdownPath,
  onCancel,
  onOverwrite,
  onAddSuffix,
  errorMessage,
}: {
  audioPath: string;
  jsonPath: string;
  markdownPath: string;
  onCancel: () => void;
  onOverwrite: () => void;
  onAddSuffix: () => void;
  errorMessage?: Message | null;
}): ReactElement {
  const { t } = useI18n();
  return (
    <DecisionModal
      title={t("decision.fileExistsTitle")}
      body={t("decision.fileExistsBody", { paths: [audioPath, jsonPath, markdownPath] })}
      actions={[
        { label: t("common.cancel"), onClick: onCancel },
        { label: t("decision.overwrite"), variant: "danger", onClick: onOverwrite },
        { label: t("decision.addSuffix"), variant: "primary", onClick: onAddSuffix },
      ]}
      onRequestClose={onCancel}
      errorMessage={errorMessage}
    />
  );
}

export function GenerateConfirmModal({
  title,
  body,
  onCancel,
  onGenerate,
}: {
  title: MessageKey;
  body: Message;
  onCancel: () => void;
  onGenerate: () => void;
}): ReactElement {
  const { t, text } = useI18n();
  return (
    <DecisionModal
      title={t(title)}
      body={text(body)}
      actions={[
        { label: t("common.cancel"), onClick: onCancel },
        { label: t("transcribe.generate"), variant: "danger", onClick: onGenerate },
      ]}
      onRequestClose={onCancel}
    />
  );
}

export function AppWideErrorModal({
  title,
  message,
  onDismiss,
}: {
  title: Message;
  message: Message;
  onDismiss: () => void;
}): ReactElement {
  const { t, text } = useI18n();
  return (
    <DecisionModal
      title={text(title)}
      body={text(message)}
      actions={[{ label: t("common.close"), variant: "primary", onClick: onDismiss }]}
      onRequestClose={onDismiss}
    />
  );
}

export function RemoveRecordingModal({
  body,
  onCancel,
  onRemove,
  errorMessage,
}: {
  body: Message;
  onCancel: () => void;
  onRemove: () => void;
  errorMessage?: Message | null;
}): ReactElement {
  const { t, text } = useI18n();
  return (
    <DecisionModal
      title={t("decision.removeTitle")}
      body={text(body)}
      actions={[
        { label: t("common.cancel"), onClick: onCancel },
        { label: t("common.remove"), variant: "danger", onClick: onRemove },
      ]}
      onRequestClose={onCancel}
      errorMessage={errorMessage}
    />
  );
}
