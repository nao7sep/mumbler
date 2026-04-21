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
        <div style={{ padding: "0 0 8px" }}>
          <p style={{ margin: "0 0 8px", fontWeight: 600 }}>Mumbler</p>
          <p style={{ margin: "0 0 12px", fontSize: 13, color: "#555", lineHeight: 1.6 }}>
            Turn voice memos into titled, searchable text files — in seconds.
          </p>
          <div style={{ display: "flex", gap: 16, marginBottom: 16 }}>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" style={{ fontSize: 13, color: "#0066cc", textDecoration: "none" }}>
              GitHub ↗
            </a>
            <a href={`${GITHUB_URL}/issues`} target="_blank" rel="noreferrer" style={{ fontSize: 13, color: "#0066cc", textDecoration: "none" }}>
              Report Issue ↗
            </a>
          </div>
          <p style={{ margin: 0, fontSize: 12, color: "#aaa" }}>
            &copy; 2026 Yoshinao Inoguchi &mdash; MIT License
          </p>
        </div>
      </section>
    </div>
  );
}

