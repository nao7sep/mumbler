import { useState, useRef, type Dispatch, type SetStateAction } from "react";

import type { AppSnapshot, SettingsDraft } from "@shared/app-shell";

interface UseSettingsModalOptions {
  onSnapshotUpdate: (snapshot: AppSnapshot) => void;
  onError: (message: string | null) => void;
  onNotice: (message: string) => void;
}

interface UseSettingsModalResult {
  settingsDraft: SettingsDraft | null;
  isLoadingSettings: boolean;
  isSavingSettings: boolean;
  isPickingSettingsOutputDirectory: boolean;
  settingsErrorMessage: string | null;
  showDiscardConfirm: boolean;
  setSettingsDraft: Dispatch<SetStateAction<SettingsDraft | null>>;
  setSettingsErrorMessage: Dispatch<SetStateAction<string | null>>;
  handleOpenSettings: () => Promise<void>;
  handlePickSettingsOutputDirectory: () => Promise<void>;
  handleSaveSettings: () => Promise<void>;
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
  const [isPickingSettingsOutputDirectory, setIsPickingSettingsOutputDirectory] = useState(false);
  const [settingsErrorMessage, setSettingsErrorMessage] = useState<string | null>(null);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const initialDraftRef = useRef<SettingsDraft | null>(null);

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
    const isDirty = JSON.stringify(settingsDraft) !== JSON.stringify(initialDraftRef.current);
    if (!isDirty) {
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
    isLoadingSettings,
    isSavingSettings,
    isPickingSettingsOutputDirectory,
    settingsErrorMessage,
    showDiscardConfirm,
    setSettingsDraft,
    setSettingsErrorMessage,
    handleOpenSettings,
    handlePickSettingsOutputDirectory,
    handleSaveSettings,
    handleRequestCloseSettings,
    handleConfirmDiscardSettings,
    handleCancelDiscardSettings,
  };
}
