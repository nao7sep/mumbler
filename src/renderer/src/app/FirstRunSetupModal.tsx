import { useEffect, useState, type ReactElement } from "react";
import type { AppSnapshot } from "@shared/app-shell";
import { message, type Message } from "@shared/i18n/translate";
import { useI18n } from "../i18n/I18nContext";
import { AudioToolsModal, type AudioToolsModalProps } from "./AudioToolsModal";
import { DiscardSettingsModal } from "./DecisionModals";
import { ModalShell } from "./modal/ModalShell";
import { presentFailure } from "./presentFailure";

export function FirstRunSetupModal({ snapshot, tools, onSnapshot, onClose }: {
  snapshot: AppSnapshot;
  tools: Omit<AudioToolsModalProps, "onClose">;
  onSnapshot: (snapshot: AppSnapshot) => void;
  onClose: () => void;
}): ReactElement {
  const { t, text } = useI18n();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Message | null>(null);
  const [discard, setDiscard] = useState(false);
  const [discardNext, setDiscardNext] = useState(false);
  // Only the key is an editable draft. Folder selection saves immediately; a
  // cancelled picker writes nothing. Quit uses the ordinary settings-draft owner.
  useEffect(() => window.mumbler.onUnsavedDrafts(
    () => key.length > 0 ? ["settings"] : [], () => { void finish(); },
  ), [key, onClose]);

  async function finish(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await window.mumbler.dismissFirstRunSetup();
      onClose();
    } catch (cause) {
      setError(presentFailure(cause, message("error.settingsSave"), "setup dismissal failed"));
    } finally { setBusy(false); }
  }

  function close(): void {
    if (busy) return;
    if (key.length > 0) { setDiscardNext(false); setDiscard(true); }
    else void finish();
  }
  function next(): void {
    setKey("");
    setError(null);
    setStep(step === 1 ? 2 : 3);
  }
  async function saveKey(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      onSnapshot(await window.mumbler.setGeminiApiKey(key));
      next();
    } catch (cause) {
      setError(presentFailure(cause, message("error.apiKeySave"), "setup key save failed"));
    } finally { setBusy(false); }
  }
  async function saveFolder(pick: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const folder = pick ? await window.mumbler.pickOutputDirectory() : snapshot.settingsSummary!.defaultOutputDirectory;
      if (folder === null) return;
      onSnapshot(await window.mumbler.saveSetupDirectory(folder));
      await finish();
    } catch (cause) {
      setError(presentFailure(cause, message("error.chooseOutputFolder"), "setup folder save failed"));
    } finally { setBusy(false); }
  }
  const title = t("setup.title", { step });
  const skip = <button type="button" className="button button--ghost" disabled={busy} onClick={() => {
    if (step === 3) close();
    else if (key.length > 0) { setDiscardNext(true); setDiscard(true); }
    else next();
  }}>{t("setup.skip")}</button>;
  return <>
    {step === 1 ? <AudioToolsModal {...tools} operationError={error ?? tools.operationError} heading={title} onClose={close} footer={<>
      {skip}
      <button type="button" className="button button--primary" onClick={next}>{t("setup.next")}</button>
    </>} /> : <ModalShell key={step} title={title} onRequestClose={close} closeDisabled={busy} footer={<>
      {skip}
      {step === 2 ? <button type="button" className="button button--primary" disabled={busy || (key.trim().length === 0 && !snapshot.settingsSummary?.hasGeminiApiKey)} onClick={() => key.trim().length > 0 ? void saveKey() : next()}>{t("setup.next")}</button> : <button type="button" className="button button--primary" disabled={busy} onClick={() => void saveFolder(false)}>{t("setup.useFolder")}</button>}
    </>}>
      <div className="modal-card__body">
        {step === 2 ? <>
          <label className="field"><span>{t("settings.apiKey")}</span><input type="password" value={key} autoComplete="off" disabled={busy} placeholder={t("settings.apiKeyPlaceholder")} onChange={(event) => setKey(event.target.value)} /></label>
          {snapshot.settingsSummary?.hasGeminiApiKey && <p className="field-hint">{t("settings.apiKeyConfigured")}</p>}
          <p className="field-hint">{t("settings.apiKeyHint", { variable: "GEMINI_API_KEY" })}</p>
        </> : <>
          <p>{t("setup.folderBody")}</p>
          <p className="setup-folder">{snapshot.settingsSummary?.defaultOutputDirectory}</p>
          <button type="button" className="button button--ghost" disabled={busy} onClick={() => void saveFolder(true)}>{t("setup.chooseFolder")}</button>
        </>}
        <p className="field-hint">{t("setup.later")}</p>
        {error !== null && <p className="banner banner--error" role="alert">{text(error)}</p>}
      </div>
    </ModalShell>}
    {discard && <DiscardSettingsModal onKeepEditing={() => setDiscard(false)} onDiscard={() => { setDiscard(false); if (discardNext) next(); else void finish(); }} />}
  </>;
}
