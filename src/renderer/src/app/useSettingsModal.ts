import { useState, type Dispatch, type SetStateAction } from "react";

import type { AppSnapshot, SettingsDraft } from "@shared/app-shell";

interface UseSettingsModalOptions {
  onSnapshotUpdate: (snapshot: AppSnapshot) => void;
  onError: (message: string | null) => void;
}

interface UseSettingsModalResult {
  settingsDraft: SettingsDraft | null;
  isLoadingSettings: boolean;
  isSavingSettings: boolean;
  isPickingSettingsOutputDirectory: boolean;
  settingsErrorMessage: string | null;
  setSettingsDraft: Dispatch<SetStateAction<SettingsDraft | null>>;
  setSettingsErrorMessage: Dispatch<SetStateAction<string | null>>;
  handleOpenSettings: () => Promise<void>;
  handlePickSettingsOutputDirectory: () => Promise<void>;
  handleSaveSettings: () => Promise<void>;
}

export function useSettingsModal({
  onSnapshotUpdate,
  onError,
}: UseSettingsModalOptions): UseSettingsModalResult {
  const [settingsDraft, setSettingsDraft] = useState<SettingsDraft | null>(null);
  const [isLoadingSettings, setIsLoadingSettings] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [isPickingSettingsOutputDirectory, setIsPickingSettingsOutputDirectory] = useState(false);
  const [settingsErrorMessage, setSettingsErrorMessage] = useState<string | null>(null);

  async function handleOpenSettings(): Promise<void> {
    setIsLoadingSettings(true);
    try {
      const draft = await window.mumbler.getSettingsDraft();
      setSettingsDraft(draft);
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
      onError(null);
    } catch (error: unknown) {
      setSettingsErrorMessage(error instanceof Error ? error.message : "Failed to save settings.");
    } finally {
      setIsSavingSettings(false);
    }
  }

  return {
    settingsDraft,
    isLoadingSettings,
    isSavingSettings,
    isPickingSettingsOutputDirectory,
    settingsErrorMessage,
    setSettingsDraft,
    setSettingsErrorMessage,
    handleOpenSettings,
    handlePickSettingsOutputDirectory,
    handleSaveSettings,
  };
}
