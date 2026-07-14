import { useMemo, useState, useRef, type Dispatch, type SetStateAction } from "react";

import type { AppSnapshot, SettingsDraft } from "@shared/app-shell";

interface UseSettingsModalOptions {
  onSnapshotUpdate: (snapshot: AppSnapshot) => void;
  onError: (message: string | null) => void;
  onNotice: (message: string) => void;
}

interface UseSettingsModalResult {
  settingsDraft: SettingsDraft | null;
  isSettingsDirty: boolean;
  isLoadingSettings: boolean;
  isSavingSettings: boolean;
  isSavingApiKey: boolean;
  isPickingSettingsOutputDirectory: boolean;
  isPickingSettingsBackupDirectory: boolean;
  settingsErrorMessage: string | null;
  showDiscardConfirm: boolean;
  setSettingsDraft: Dispatch<SetStateAction<SettingsDraft | null>>;
  setSettingsErrorMessage: Dispatch<SetStateAction<string | null>>;
  handleOpenSettings: () => Promise<void>;
  handlePickSettingsOutputDirectory: () => Promise<void>;
  handlePickSettingsBackupDirectory: () => Promise<void>;
  handleSaveSettings: () => Promise<void>;
  handleSetGeminiApiKey: (apiKey: string) => Promise<void>;
  handleClearGeminiApiKey: () => Promise<void>;
  handleRestoreDefaultPrompts: () => Promise<void>;
  handleRestoreDefaultModels: () => Promise<void>;
  handleRequestCloseSettings: () => void;
  handleConfirmDiscardSettings: () => void;
  handleCancelDiscardSettings: () => void;
}

export function useSettingsModal({
  onSnapshotUpdate,
  onError,
  onNotice,
}: UseSettingsModalOptions): UseSettingsModalResult {
  const [settingsDraft, setSettingsDraft] = useState<SettingsDraft | null>(null);
  const [isLoadingSettings, setIsLoadingSettings] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [isSavingApiKey, setIsSavingApiKey] = useState(false);
  const [isPickingSettingsOutputDirectory, setIsPickingSettingsOutputDirectory] = useState(false);
  const [isPickingSettingsBackupDirectory, setIsPickingSettingsBackupDirectory] = useState(false);
  const [settingsErrorMessage, setSettingsErrorMessage] = useState<string | null>(null);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const initialDraftRef = useRef<SettingsDraft | null>(null);

  // Recomputes only when the draft object changes, not on every App re-render
  // (App re-renders on each pipeline-progress snapshot while Settings is open).
  // initialDraftRef is only reassigned together with settingsDraft (open/save).
  const isSettingsDirty = useMemo(
    () =>
      settingsDraft !== null &&
      JSON.stringify(settingsDraft) !== JSON.stringify(initialDraftRef.current),
    [settingsDraft],
  );

  async function handleOpenSettings(): Promise<void> {
    setIsLoadingSettings(true);
    try {
      const draft = await window.mumbler.getSettingsDraft();
      setSettingsDraft(draft);
      initialDraftRef.current = draft;
      setSettingsErrorMessage(null);
    } catch (error: unknown) {
      onError(error instanceof Error ? error.message : "Failed to load settings.");
    } finally {
      setIsLoadingSettings(false);
    }
  }

  async function handlePickSettingsOutputDirectory(): Promise<void> {
    setIsPickingSettingsOutputDirectory(true);
    try {
      const nextPath = await window.mumbler.pickOutputDirectory();
      if (nextPath !== null) {
        setSettingsDraft((current) =>
          current === null
            ? current
            : {
                ...current,
                outputDirectory: nextPath,
              },
        );
      }
      setSettingsErrorMessage(null);
    } catch (error: unknown) {
      setSettingsErrorMessage(
        error instanceof Error ? error.message : "Failed to choose output directory.",
      );
    } finally {
      setIsPickingSettingsOutputDirectory(false);
    }
  }

  async function handlePickSettingsBackupDirectory(): Promise<void> {
    setIsPickingSettingsBackupDirectory(true);
    try {
      const nextPath = await window.mumbler.pickOutputDirectory();
      if (nextPath !== null) {
        setSettingsDraft((current) =>
          current === null
            ? current
            : {
                ...current,
                backupDirectory: nextPath,
              },
        );
      }
      setSettingsErrorMessage(null);
    } catch (error: unknown) {
      setSettingsErrorMessage(
        error instanceof Error ? error.message : "Failed to choose backup directory.",
      );
    } finally {
      setIsPickingSettingsBackupDirectory(false);
    }
  }

  async function handleSaveSettings(): Promise<void> {
    if (settingsDraft === null) {
      return;
    }

    setIsSavingSettings(true);
    try {
      const nextSnapshot = await window.mumbler.saveSettingsDraft(settingsDraft);
      onSnapshotUpdate(nextSnapshot);
      setSettingsDraft(null);
      setSettingsErrorMessage(null);
      setShowDiscardConfirm(false);
      initialDraftRef.current = null;
      onNotice("Settings saved.");
    } catch (error: unknown) {
      setSettingsErrorMessage(error instanceof Error ? error.message : "Failed to save settings.");
    } finally {
      setIsSavingSettings(false);
    }
  }

  // The Gemini API key is a secret, not a setting: it is committed immediately
  // through its own IPC to the dedicated 0600 secrets file, never bundled into the
  // settings-JSON Save. On success we reflect the new presence into both the live
  // draft and the dirty baseline, so the key action does not leave the form
  // looking dirty and the password field can clear itself.
  function applyHasKey(hasGeminiApiKey: boolean): void {
    setSettingsDraft((current) => (current === null ? current : { ...current, hasGeminiApiKey }));
    if (initialDraftRef.current !== null) {
      initialDraftRef.current = { ...initialDraftRef.current, hasGeminiApiKey };
    }
  }

  async function handleSetGeminiApiKey(apiKey: string): Promise<void> {
    const trimmed = apiKey.trim();
    if (trimmed.length === 0) {
      return;
    }
    setIsSavingApiKey(true);
    try {
      const nextSnapshot = await window.mumbler.setGeminiApiKey(trimmed);
      onSnapshotUpdate(nextSnapshot);
      applyHasKey(nextSnapshot.settingsSummary?.hasGeminiApiKey ?? true);
      setSettingsErrorMessage(null);
      onNotice("Gemini API key saved.");
    } catch (error: unknown) {
      setSettingsErrorMessage(
        error instanceof Error ? error.message : "Failed to save Gemini API key.",
      );
    } finally {
      setIsSavingApiKey(false);
    }
  }

  async function handleClearGeminiApiKey(): Promise<void> {
    setIsSavingApiKey(true);
    try {
      const nextSnapshot = await window.mumbler.clearGeminiApiKey();
      onSnapshotUpdate(nextSnapshot);
      applyHasKey(nextSnapshot.settingsSummary?.hasGeminiApiKey ?? false);
      setSettingsErrorMessage(null);
      // An env-supplied key can still resolve after clearing the stored one, so
      // the message reflects what actually happened rather than assuming removal.
      onNotice(
        nextSnapshot.settingsSummary?.hasGeminiApiKey
          ? "Stored key removed; an environment key is still in use."
          : "Gemini API key removed.",
      );
    } catch (error: unknown) {
      setSettingsErrorMessage(
        error instanceof Error ? error.message : "Failed to remove Gemini API key.",
      );
    } finally {
      setIsSavingApiKey(false);
    }
  }

  async function handleRestoreDefaultPrompts(): Promise<void> {
    try {
      const defaults = await window.mumbler.getDefaultPrompts();
      setSettingsDraft((current) =>
        current === null
          ? current
          : {
              ...current,
              structuredPrompt: defaults.structured,
              titlePrompt: defaults.title,
              slugPrompt: defaults.slug,
            },
      );
      setSettingsErrorMessage(null);
    } catch (error: unknown) {
      setSettingsErrorMessage(
        error instanceof Error ? error.message : "Failed to load default prompts.",
      );
    }
  }

  // Reset-to-latest for the owned Gemini model list (config-seeding-conventions'
  // restore-defaults): pulls the current built-in models and default selections
  // into the draft, replacing the user's list and selections wholesale. The button
  // that calls this warns first and is framed as getting the latest, not undoing.
  async function handleRestoreDefaultModels(): Promise<void> {
    try {
      const defaults = await window.mumbler.getDefaultModels();
      setSettingsDraft((current) =>
        current === null
          ? current
          : {
              ...current,
              geminiModelsText: defaults.models.join("\n"),
              transcriptionModel: defaults.transcriptionModel,
              metadataModel: defaults.metadataModel,
            },
      );
      setSettingsErrorMessage(null);
    } catch (error: unknown) {
      setSettingsErrorMessage(
        error instanceof Error ? error.message : "Failed to load default models.",
      );
    }
  }

  function handleCloseSettings(): void {
    setSettingsDraft(null);
    setSettingsErrorMessage(null);
    setShowDiscardConfirm(false);
    initialDraftRef.current = null;
  }

  function handleRequestCloseSettings(): void {
    if (showDiscardConfirm) {
      return;
    }
    if (!isSettingsDirty) {
      handleCloseSettings();
    } else {
      setShowDiscardConfirm(true);
    }
  }

  function handleConfirmDiscardSettings(): void {
    handleCloseSettings();
  }

  function handleCancelDiscardSettings(): void {
    setShowDiscardConfirm(false);
  }

  return {
    settingsDraft,
    isSettingsDirty,
    isLoadingSettings,
    isSavingSettings,
    isSavingApiKey,
    isPickingSettingsOutputDirectory,
    isPickingSettingsBackupDirectory,
    settingsErrorMessage,
    showDiscardConfirm,
    setSettingsDraft,
    setSettingsErrorMessage,
    handleOpenSettings,
    handlePickSettingsOutputDirectory,
    handlePickSettingsBackupDirectory,
    handleSaveSettings,
    handleSetGeminiApiKey,
    handleClearGeminiApiKey,
    handleRestoreDefaultPrompts,
    handleRestoreDefaultModels,
    handleRequestCloseSettings,
    handleConfirmDiscardSettings,
    handleCancelDiscardSettings,
  };
}
