import { shellApi } from "@renderer/shell-api";
import { useCallback, useEffect, useMemo, useState, useRef, type Dispatch, type SetStateAction } from "react";

import type { AppSnapshot, SettingsDraft } from "@shared/app-shell";
import { presentFailure } from "./presentFailure";
import { message, type Message } from "@shared/i18n/translate";

interface UseSettingsModalOptions {
  onSnapshotUpdate: (snapshot: AppSnapshot) => void;
  onError: (message: Message) => void;
  onNotice: (message: Message) => void;
  // A notice that stays until closed, for news the user must not miss.
  onLastingNotice: (message: Message) => void;
}

interface UseSettingsModalResult {
  settingsDraft: SettingsDraft | null;
  apiKeyInput: string;
  setApiKeyInput: Dispatch<SetStateAction<string>>;
  isSettingsDirty: boolean;
  isLoadingSettings: boolean;
  isSavingSettings: boolean;
  isSavingApiKey: boolean;
  isPickingSettingsOutputDirectory: boolean;
  isPickingSettingsBackupDirectory: boolean;
  settingsErrorMessage: Message | null;
  showDiscardConfirm: boolean;
  setSettingsDraft: Dispatch<SetStateAction<SettingsDraft | null>>;
  setSettingsErrorMessage: Dispatch<SetStateAction<Message | null>>;
  handleOpenSettings: () => Promise<void>;
  handlePickSettingsOutputDirectory: () => Promise<void>;
  handlePickSettingsBackupDirectory: () => Promise<void>;
  handleSaveSettings: () => Promise<void>;
  handleSetGeminiApiKey: (apiKey: string) => Promise<void>;
  handleClearGeminiApiKey: () => Promise<void>;
  handleRestoreDefaultPrompts: () => Promise<void>;
  handleRequestCloseSettings: () => void;
  handleConfirmDiscardSettings: () => void;
  handleCancelDiscardSettings: () => void;
}

export function useSettingsModal({
  onSnapshotUpdate,
  onError,
  onNotice,
  onLastingNotice,
}: UseSettingsModalOptions): UseSettingsModalResult {
  const [settingsDraft, updateSettingsDraft] = useState<SettingsDraft | null>(null);
  const [apiKeyInput, updateApiKeyInput] = useState("");
  const [initialDraft, setInitialDraft] = useState<SettingsDraft | null>(null);
  // Save completion can share a React batch with a field change. Update these
  // refs at the change boundary so settlement sees even not-yet-rendered edits.
  const currentDraftRef = useRef<SettingsDraft | null>(null);
  const setSettingsDraft = useCallback<Dispatch<SetStateAction<SettingsDraft | null>>>((action) => {
    const next = typeof action === "function" ? action(currentDraftRef.current) : action;
    currentDraftRef.current = next;
    updateSettingsDraft(next);
  }, []);
  const apiKeyInputRef = useRef("");
  const setApiKeyInput = useCallback<Dispatch<SetStateAction<string>>>((action) => {
    const next = typeof action === "function" ? action(apiKeyInputRef.current) : action;
    apiKeyInputRef.current = next;
    updateApiKeyInput(next);
  }, []);
  const savingSettingsRef = useRef(false);
  const savingApiKeyRef = useRef(false);
  const [isLoadingSettings, setIsLoadingSettings] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [isSavingApiKey, setIsSavingApiKey] = useState(false);
  const [isPickingSettingsOutputDirectory, setIsPickingSettingsOutputDirectory] = useState(false);
  const [isPickingSettingsBackupDirectory, setIsPickingSettingsBackupDirectory] = useState(false);
  const [settingsErrorMessage, setSettingsErrorMessage] = useState<Message | null>(null);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const isSettingsDirty = useMemo(() => settingsDraft !== null && (
    apiKeyInput.length > 0 || JSON.stringify(settingsDraft) !== JSON.stringify(initialDraft)
  ), [settingsDraft, initialDraft, apiKeyInput]);

  async function handleOpenSettings(): Promise<void> {
    setIsLoadingSettings(true);
    try {
      const draft = await shellApi.getSettingsDraft();
      setSettingsDraft(draft);
      setInitialDraft(draft);
      setApiKeyInput("");
      setSettingsErrorMessage(null);
    } catch (error: unknown) {
      onError(presentFailure(error, message("error.settingsLoad"), "settings load failed"));
    } finally {
      setIsLoadingSettings(false);
    }
  }

  async function handlePickSettingsOutputDirectory(): Promise<void> {
    setIsPickingSettingsOutputDirectory(true);
    try {
      const nextPath = await shellApi.pickOutputDirectory(
        settingsDraft?.outputDirectory, settingsDraft?.literalOutputDirectory,
      );
      if (nextPath !== null) {
        setSettingsDraft((current) =>
          current === null
            ? current
            : {
                ...current,
                outputDirectory: nextPath,
                literalOutputDirectory: nextPath,
              },
        );
      }
      setSettingsErrorMessage(null);
    } catch (error: unknown) {
      setSettingsErrorMessage(presentFailure(error, message("error.chooseOutputFolder"), "settings output folder selection failed"));
    } finally {
      setIsPickingSettingsOutputDirectory(false);
    }
  }

  async function handlePickSettingsBackupDirectory(): Promise<void> {
    setIsPickingSettingsBackupDirectory(true);
    try {
      const nextPath = await shellApi.pickBackupDirectory(
        settingsDraft?.backupDirectory, settingsDraft?.literalBackupDirectory,
      );
      if (nextPath !== null) {
        setSettingsDraft((current) =>
          current === null
            ? current
            : {
                ...current,
                backupDirectory: nextPath,
                literalBackupDirectory: nextPath,
              },
        );
      }
      setSettingsErrorMessage(null);
    } catch (error: unknown) {
      setSettingsErrorMessage(presentFailure(error, message("error.chooseBackupFolder"), "settings backup folder selection failed"));
    } finally {
      setIsPickingSettingsBackupDirectory(false);
    }
  }

  async function handleSaveSettings(): Promise<void> {
    const submittedDraft = currentDraftRef.current;
    if (submittedDraft === null || savingSettingsRef.current) {
      return;
    }

    savingSettingsRef.current = true;
    setIsSavingSettings(true);
    try {
      const nextSnapshot = await shellApi.saveSettingsDraft(submittedDraft);
      onSnapshotUpdate(nextSnapshot);
      const currentDraft = currentDraftRef.current;
      if (currentDraft === submittedDraft && apiKeyInputRef.current.length === 0) {
        handleCloseSettings();
      } else if (currentDraft !== null) {
        // The completed save settles only its submitted revision. Further edits
        // remain in the modal, compared with what was actually persisted.
        setInitialDraft({ ...submittedDraft, hasGeminiApiKey: currentDraft.hasGeminiApiKey });
      }
      setSettingsErrorMessage(null);
      onNotice(message("notice.settingsSaved"));
    } catch (error: unknown) {
      setSettingsErrorMessage(presentFailure(error, message("error.settingsSave"), "settings save failed"));
    } finally {
      savingSettingsRef.current = false;
      setIsSavingSettings(false);
    }
  }

  // The Gemini API key is a secret, not a setting: it is committed immediately
  // through its own IPC to the dedicated 0600 secrets file, never bundled into the
  // settings-JSON Save. On success we reflect the new presence into both the live
  // draft and the dirty baseline, so the key action does not leave the form
  // looking dirty. The secret draft clears only after its own save succeeds.
  function applyHasKey(hasGeminiApiKey: boolean): void {
    setSettingsDraft((current) => (current === null ? current : { ...current, hasGeminiApiKey }));
    setInitialDraft((current) => current === null ? current : { ...current, hasGeminiApiKey });
  }

  async function handleSetGeminiApiKey(apiKey: string): Promise<void> {
    const trimmed = apiKey.trim();
    if (trimmed.length === 0 || savingApiKeyRef.current) {
      return;
    }
    savingApiKeyRef.current = true;
    setIsSavingApiKey(true);
    try {
      const nextSnapshot = await shellApi.setGeminiApiKey(trimmed);
      onSnapshotUpdate(nextSnapshot);
      applyHasKey(nextSnapshot.settingsSummary?.hasGeminiApiKey ?? true);
      setApiKeyInput((current) => current === apiKey ? "" : current);
      setSettingsErrorMessage(null);
      onNotice(message("notice.apiKeySaved"));
    } catch (error: unknown) {
      setSettingsErrorMessage(presentFailure(error, message("error.apiKeySave"), "Gemini API key save failed"));
    } finally {
      savingApiKeyRef.current = false;
      setIsSavingApiKey(false);
    }
  }

  async function handleClearGeminiApiKey(): Promise<void> {
    if (savingApiKeyRef.current) return;
    savingApiKeyRef.current = true;
    setIsSavingApiKey(true);
    try {
      const nextSnapshot = await shellApi.clearGeminiApiKey();
      onSnapshotUpdate(nextSnapshot);
      applyHasKey(nextSnapshot.settingsSummary?.hasGeminiApiKey ?? false);
      setSettingsErrorMessage(null);
      // An env-supplied key can still resolve after clearing the stored one, so
      // the message reflects what actually happened rather than assuming removal,
      // and that surprise stays until the user closes it.
      if (nextSnapshot.settingsSummary?.hasGeminiApiKey) {
        onLastingNotice(message("notice.apiKeyRemovedEnvRemains"));
      } else {
        onNotice(message("notice.apiKeyRemoved"));
      }
    } catch (error: unknown) {
      setSettingsErrorMessage(presentFailure(error, message("error.apiKeyRemove"), "Gemini API key removal failed"));
    } finally {
      savingApiKeyRef.current = false;
      setIsSavingApiKey(false);
    }
  }

  // A reset only fills the draft with the built-ins: Save then stores nothing for a
  // set equal to its built-in, and Cancel discards it with every other edit.
  async function handleRestoreDefaultPrompts(): Promise<void> {
    try {
      const defaults = await shellApi.getDefaultPrompts();
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
      setSettingsErrorMessage(presentFailure(error, message("error.defaultPromptsLoad"), "default prompts load failed"));
    }
  }

  function handleCloseSettings(): void {
    setSettingsDraft(null);
    setSettingsErrorMessage(null);
    setShowDiscardConfirm(false);
    setInitialDraft(null);
    setApiKeyInput("");
  }

  // A user's quit or window close asks before it discards unsaved Settings
  // changes, and closes Settings without saving when the user discards them
  // (unsaved-edits-conventions). The ref keeps the registration stable.
  const unsavedRef = useRef(isSettingsDirty);
  unsavedRef.current = isSettingsDirty;
  const closeRef = useRef(handleCloseSettings);
  closeRef.current = handleCloseSettings;
  useEffect(() => shellApi.onUnsavedDrafts(
    () => (unsavedRef.current ? ["settings"] : []),
    () => closeRef.current(),
  ), []);

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
    apiKeyInput,
    setApiKeyInput,
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
    handleRequestCloseSettings,
    handleConfirmDiscardSettings,
    handleCancelDiscardSettings,
  };
}
