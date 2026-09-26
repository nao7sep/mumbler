import { useRef, useState, type ReactElement } from "react";

import { ModalShell } from "./modal/ModalShell";
import { ExternalLinkIcon } from "./Icon";
import { InlineError } from "./InlineResult";
import { presentFailure } from "./presentFailure";
import { useI18n } from "../i18n/I18nContext";
import { message, type Message } from "@shared/i18n/translate";

const GITHUB_URL = "https://github.com/nao7sep/mumbler";

export function AboutModal({
  version,
  onClose,
}: {
  version: string;
  onClose: () => void;
}): ReactElement {
  const { t, text } = useI18n();
  const [linkFailures, setLinkFailures] = useState<Record<"repo" | "issues", Message | undefined>>({
    repo: undefined,
    issues: undefined,
  });
  const linkAttempts = useRef<Record<"repo" | "issues", number>>({ repo: 0, issues: 0 });

  async function openLink(owner: "repo" | "issues", url: string): Promise<void> {
    const attempt = ++linkAttempts.current[owner];
    try {
      await window.mumbler.openExternal(url);
      if (linkAttempts.current[owner] !== attempt) return;
      setLinkFailures((current) => ({ ...current, [owner]: undefined }));
    } catch (error) {
      const failure = owner === "repo"
        ? message("about.repoLinkFailed")
        : message("about.issuesLinkFailed");
      const presented = presentFailure(error, failure, `about ${owner} link failed`);
      if (linkAttempts.current[owner] !== attempt) return;
      setLinkFailures((current) => ({
        ...current,
        [owner]: presented,
      }));
    }
  }

  return (
    <ModalShell
      title={t("about.title")}
      titleVisuallyHidden
      size="narrow"
      onRequestClose={onClose}
      describedById="about-description"
      footer={
        <button type="button" className="button button--ghost" onClick={onClose}>
          {t("common.close")}
        </button>
      }
    >
      <div className="modal-card__body about-content">
        <div className="about-identity">
          <p className="about-title">Mumbler</p>
          {version ? <p className="about-version">{t("about.version", { version })}</p> : null}
        </div>
        <p id="about-description" className="about-copy">
          {t("about.description")}
        </p>
        <div className="about-links">
          <a href={GITHUB_URL} target="_blank" rel="noreferrer" onClick={(event) => { event.preventDefault(); void openLink("repo", GITHUB_URL); }}>
            GitHub <ExternalLinkIcon />
          </a>
          <a href={`${GITHUB_URL}/issues`} target="_blank" rel="noreferrer" onClick={(event) => { event.preventDefault(); void openLink("issues", `${GITHUB_URL}/issues`); }}>
            {t("about.reportIssue")} <ExternalLinkIcon />
          </a>
        </div>
        {linkFailures.repo ? (
          <InlineError onDismiss={() => setLinkFailures((current) => ({ ...current, repo: undefined }))}>
            {text(linkFailures.repo)}
          </InlineError>
        ) : null}
        {linkFailures.issues ? (
          <InlineError onDismiss={() => setLinkFailures((current) => ({ ...current, issues: undefined }))}>
            {text(linkFailures.issues)}
          </InlineError>
        ) : null}
        <p className="about-meta">
          {t("about.copyright", { year: "2026", author: "Yoshinao Inoguchi" })}
        </p>
      </div>
    </ModalShell>
  );
}
