import { shellApi } from "@renderer/shell-api";
import { useEffect, useMemo, useState, type ReactElement } from "react";
import type { ShellSnapshot as AppSnapshot } from "@shared/app-shell";
import { message, type Message } from "@shared/i18n/translate";
import { SYSTEM_TIMEZONE, getSupportedTimezones, getSystemTimezone } from "@shared/timestamps";
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
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [key, setKey] = useState("");
  const summary = snapshot.settingsSummary!;
  // The interpretation zone, the only zone setup shows (timestamp-conventions):
  // first launch saved the computer's, which stays when the computer's changes
  // unless the user chooses System.
  const [timezone, setTimezone] = useState(summary.defaultTimezone);
  const timezones = useMemo(() => getSupportedTimezones(), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Message | null>(null);
  const [discard, setDiscard] = useState(false);
  const [discardNext, setDiscardNext] = useState(false);
  // The key is an editable draft, and so is a time zone changed but not yet
  // used. A folder saves as soon as it is picked; a cancelled picker writes
  // nothing. Quit uses the ordinary settings-draft owner.
  const dirty = key.length > 0 || (step === 4 && timezone !== summary.defaultTimezone);
  useEffect(() => shellApi.onUnsavedDrafts(
    () => dirty ? ["settings"] : [], () => { void finish(); },
  ), [dirty, onClose]);

  async function finish(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await shellApi.dismissFirstRunSetup();
      onClose();
    } catch (cause) {
      setError(presentFailure(cause, message("error.settingsSave"), "setup dismissal failed"));
    } finally { setBusy(false); }
  }

  function close(): void {
    if (busy) return;
    if (dirty) { setDiscardNext(false); setDiscard(true); }
    else void finish();
  }
  function next(): void {
    setKey("");
    setError(null);
    setStep(step === 1 ? 2 : step === 2 ? 3 : 4);
  }
  async function saveKey(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      onSnapshot(await shellApi.setGeminiApiKey(key));
      next();
    } catch (cause) {
      setError(presentFailure(cause, message("error.apiKeySave"), "setup key save failed"));
    } finally { setBusy(false); }
  }
  async function run(work: () => Promise<void>, failure: Message, context: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(presentFailure(cause, failure, context));
    } finally { setBusy(false); }
  }
  // A picked folder is saved at once and the step stays open on it.
  const pickOutput = () => run(async () => {
    const folder = await shellApi.pickOutputDirectory();
    if (folder !== null) onSnapshot(await shellApi.saveSetupDirectory(folder));
  }, message("error.chooseOutputFolder"), "setup output folder save failed");
  const pickRecordings = () => run(async () => {
    onSnapshot(await shellApi.chooseOriginalsDirectory());
  }, message("error.chooseBackupFolder"), "setup recordings folder save failed");
  // Use These Folders saves each suggestion not already replaced by a pick. Each
  // save shows at once, so one that succeeded stays shown when the other fails,
  // and a failure names its own folder.
  async function useFolders(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      if (summary.backupDirectory === null) {
        try {
          onSnapshot(await shellApi.saveSetupRecordingsDirectory(summary.defaultBackupDirectory));
        } catch (cause) {
          setError(presentFailure(cause, message("error.chooseBackupFolder"), "setup recordings folder save failed"));
          return;
        }
      }
      if (summary.outputDirectory === null) {
        try {
          onSnapshot(await shellApi.saveSetupDirectory(summary.defaultOutputDirectory));
        } catch (cause) {
          setError(presentFailure(cause, message("error.chooseOutputFolder"), "setup output folder save failed"));
          return;
        }
      }
      next();
    } finally { setBusy(false); }
  }
  const useTimezone = () => run(async () => {
    onSnapshot(await shellApi.saveSetupTimezone(timezone));
    await finish();
  }, message("error.settingsSave"), "setup time zone save failed");
  const title = t("setup.title", { step });
  const skip = <button type="button" className="button button--ghost" disabled={busy} onClick={() => {
    if (step === 4) close();
    else if (key.length > 0) { setDiscardNext(true); setDiscard(true); }
    else next();
  }}>{t("setup.skip")}</button>;
  return <>
    {step === 1 ? <AudioToolsModal {...tools} operationError={error ?? tools.operationError} heading={title} onClose={close} footer={<>
      {skip}
      <button type="button" className="button button--primary" onClick={next}>{t("setup.next")}</button>
    </>} /> : <ModalShell key={step} title={title} onRequestClose={close} closeDisabled={busy} footer={<>
      {skip}
      {step === 2 ? <button type="button" className="button button--primary" disabled={busy || (key.trim().length === 0 && !summary.hasGeminiApiKey)} onClick={() => key.trim().length > 0 ? void saveKey() : next()}>{t("setup.next")}</button>
        : step === 3 ? <button type="button" className="button button--primary" disabled={busy} onClick={() => void useFolders()}>{t("setup.useFolder")}</button>
          : <button type="button" className="button button--primary" disabled={busy} onClick={() => void useTimezone()}>{t("setup.useTimezone")}</button>}
    </>}>
      <div className="modal-card__body">
        {step === 2 ? <>
          <label className="field"><span>{t("settings.apiKey")}</span><input type="password" value={key} autoComplete="off" disabled={busy} placeholder={t("settings.apiKeyPlaceholder")} onChange={(event) => setKey(event.target.value)} /></label>
          {snapshot.settingsSummary?.hasGeminiApiKey && <p className="field-hint">{t("settings.apiKeyConfigured")}</p>}
          <p className="field-hint">{t("settings.apiKeyHint", { variable: "GEMINI_API_KEY" })}</p>
        </> : step === 3 ? <>
          {/* Recordings come in before exports go out, so their folder leads. */}
          <section className="setup-section" aria-labelledby="setup-recordings">
            <h3 id="setup-recordings">{t("settings.backupDirectory")}</h3>
            <p>{t("setup.recordingsBody")}</p>
            <p className="setup-folder">{summary.backupDirectory ?? summary.defaultBackupDirectory}</p>
            <button type="button" className="button button--ghost" disabled={busy} onClick={() => void pickRecordings()}>{t("setup.chooseFolder")}</button>
          </section>
          <section className="setup-section" aria-labelledby="setup-output">
            <h3 id="setup-output">{t("settings.outputDirectory")}</h3>
            <p>{t("setup.outputBody")}</p>
            <p className="setup-folder">{summary.outputDirectory ?? summary.defaultOutputDirectory}</p>
            <button type="button" className="button button--ghost" disabled={busy} onClick={() => void pickOutput()}>{t("setup.chooseFolder")}</button>
          </section>
        </> : <>
          <p>{t("setup.timezoneBody")}</p>
          <label className="field">
            <span>{t("settings.defaultTimezone")}</span>
            <select value={timezone} disabled={busy} onChange={(event) => setTimezone(event.target.value)}>
              <option value={SYSTEM_TIMEZONE}>{t("settings.timezoneSystem", { zone: getSystemTimezone() })}</option>
              {timezones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
            </select>
          </label>
        </>}
        <p className="field-hint">{t("setup.later")}</p>
        {error !== null && <p className="banner banner--error" role="alert">{text(error)}</p>}
      </div>
    </ModalShell>}
    {discard && <DiscardSettingsModal onKeepEditing={() => setDiscard(false)} onDiscard={() => { setDiscard(false); if (discardNext) next(); else void finish(); }} />}
  </>;
}
