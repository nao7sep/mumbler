import type { ReactElement } from "react";

const GITHUB_URL = "https://github.com/nao7sep/mumbler";

export function AboutModal({ onClose }: { onClose: () => void }): ReactElement {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="modal-card modal-card--narrow" onClick={(e) => e.stopPropagation()}>
        <div className="modal-card__header">
          <h2>About Mumbler</h2>
          <button type="button" className="button button--ghost button--compact modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-card__body about-content">
          <p className="about-title">Mumbler</p>
          <p className="about-copy">
            Keep your voice recordings organized. Import, transcribe, and export — all in one place.
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
      </section>
    </div>
  );
}
