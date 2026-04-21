import type { ReactElement } from "react";

export function AboutModal({ version, onClose }: { version: string; onClose: () => void }): ReactElement {
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
          <p style={{ margin: "0 0 6px", fontWeight: 600 }}>Mumbler</p>
          <p className="empty-state__body" style={{ margin: "0 0 4px" }}>Version {version}</p>
          <p className="empty-state__body" style={{ margin: 0 }}>Desktop audio transcription powered by Gemini AI.</p>
        </div>
      </section>
    </div>
  );
}

