import type { ReactElement } from "react";

import { ModalShell } from "./modal/ModalShell";

const GITHUB_URL = "https://github.com/nao7sep/mumbler";

export function AboutModal({
  version,
  onClose,
}: {
  version: string;
  onClose: () => void;
}): ReactElement {
  return (
    <ModalShell
      title="About Mumbler"
      size="narrow"
      onRequestClose={onClose}
      describedById="about-description"
    >
      <div className="modal-card__body about-content">
        <p className="about-title">Mumbler</p>
        {version ? <p className="about-version">Version {version}</p> : null}
        <p id="about-description" className="about-copy">
          Keep your voice recordings organized. Import, generate transcription, structure it, generate titles and slugs, and export — all in one place.
        </p>
        <div className="about-links">
          <a href={GITHUB_URL} target="_blank" rel="noreferrer">
            GitHub ↗
          </a>
          <a href={`${GITHUB_URL}/issues`} target="_blank" rel="noreferrer">
            Report Issue ↗
          </a>
        </div>
        <p className="about-meta">
          &copy; 2026 Yoshinao Inoguchi &mdash; MIT License
        </p>
      </div>
    </ModalShell>
  );
}
