import type { ReactElement } from "react";

import { DecisionModal } from "./DecisionModal";

// The concrete confirm/alert surfaces, each a named wrapper over the generic
// DecisionModal so it is findable by name (and greppable) rather than living as
// anonymous inline JSX in App.tsx. Each owns its title, action labels/variants,
// and safe-dismiss wiring; dynamic text and handlers arrive as props.

export function DiscardSettingsModal({
  onKeepEditing,
  onDiscard,
}: {
  onKeepEditing: () => void;
  onDiscard: () => void;
}): ReactElement {
  return (
    <DecisionModal
      title="Discard Changes?"
      body="You have unsaved changes. Discard them and close settings?"
      actions={[
        { label: "Keep Editing", onClick: onKeepEditing },
        { label: "Discard", variant: "danger", onClick: onDiscard },
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
  return (
    <DecisionModal
      title="Discard Changes?"
      body="You have unsaved timestamp edits. Discard them and cancel the import?"
      actions={[
        { label: "Keep Editing", onClick: onKeepEditing },
        { label: "Discard", variant: "danger", onClick: onDiscard },
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
}: {
  audioPath: string;
  jsonPath: string;
  markdownPath: string;
  onCancel: () => void;
  onOverwrite: () => void;
  onAddSuffix: () => void;
}): ReactElement {
  return (
    <DecisionModal
      title="File Exists"
      body={`One or more output files already exist: ${audioPath}, ${jsonPath}, ${markdownPath}.`}
      actions={[
        { label: "Cancel", onClick: onCancel },
        { label: "Overwrite", variant: "danger", onClick: onOverwrite },
        { label: "Add Suffix", variant: "primary", onClick: onAddSuffix },
      ]}
      onRequestClose={onCancel}
    />
  );
}

export function GenerateConfirmModal({
  targetLabel,
  body,
  onCancel,
  onGenerate,
}: {
  targetLabel: string;
  body: string;
  onCancel: () => void;
  onGenerate: () => void;
}): ReactElement {
  return (
    <DecisionModal
      title={`Generate ${targetLabel}?`}
      body={body}
      actions={[
        { label: "Cancel", onClick: onCancel },
        { label: "Generate", variant: "danger", onClick: onGenerate },
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
  title: string;
  message: string;
  onDismiss: () => void;
}): ReactElement {
  return (
    <DecisionModal
      title={title}
      body={message}
      actions={[{ label: "Dismiss", variant: "primary", onClick: onDismiss }]}
      onRequestClose={onDismiss}
    />
  );
}

export function RemoveRecordingModal({
  body,
  onCancel,
  onRemove,
}: {
  body: string;
  onCancel: () => void;
  onRemove: () => void;
}): ReactElement {
  return (
    <DecisionModal
      title="Remove Recording?"
      body={body}
      actions={[
        { label: "Cancel", onClick: onCancel },
        { label: "Remove", variant: "danger", onClick: onRemove },
      ]}
      onRequestClose={onCancel}
    />
  );
}
