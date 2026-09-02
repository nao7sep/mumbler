import { useRef, useState, type ReactElement } from "react";

import { ModalShell } from "./modal/ModalShell";
import { ExternalLinkIcon } from "./Icon";
import { InlineError } from "./InlineResult";
import { presentFailure } from "./presentFailure";

const GITHUB_URL = "https://github.com/nao7sep/mumbler";

export function AboutModal({
  version,
  onClose,
}: {
  version: string;
  onClose: () => void;
}): ReactElement {
  const [linkFailures, setLinkFailures] = useState<Record<"repo" | "issues", string | undefined>>({
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
      const message = owner === "repo"
        ? "GitHub could not be opened. Try again."
        : "Report Issue could not be opened. Try again.";
      const presented = presentFailure(error, message, `about ${owner} link failed`);
      if (linkAttempts.current[owner] !== attempt) return;
      setLinkFailures((current) => ({
        ...current,
        [owner]: presented,
      }));
    }
  }

  return (
    <ModalShell
      title="About Mumbler"
      size="narrow"
      onRequestClose={onClose}
      describedById="about-description"
      footer={
        <button type="button" className="button button--ghost" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="modal-card__body about-content">
        <p className="about-title">Mumbler</p>
        {version ? <p className="about-version">Version {version}</p> : null}
        <p id="about-description" className="about-copy">
          Keep your voice recordings organized. Import, generate transcription, structure it, generate titles and slugs, and export — all in one place.
        </p>
        <div className="about-links">
          <a href={GITHUB_URL} target="_blank" rel="noreferrer" onClick={(event) => { event.preventDefault(); void openLink("repo", GITHUB_URL); }}>
            GitHub <ExternalLinkIcon />
          </a>
          <a href={`${GITHUB_URL}/issues`} target="_blank" rel="noreferrer" onClick={(event) => { event.preventDefault(); void openLink("issues", `${GITHUB_URL}/issues`); }}>
            Report Issue <ExternalLinkIcon />
          </a>
        </div>
        {linkFailures.repo ? (
          <InlineError onDismiss={() => setLinkFailures((current) => ({ ...current, repo: undefined }))}>
            {linkFailures.repo}
          </InlineError>
        ) : null}
        {linkFailures.issues ? (
          <InlineError onDismiss={() => setLinkFailures((current) => ({ ...current, issues: undefined }))}>
            {linkFailures.issues}
          </InlineError>
        ) : null}
        <p className="about-meta">
          &copy; 2026 Yoshinao Inoguchi &mdash; MIT License
        </p>
      </div>
    </ModalShell>
  );
}
