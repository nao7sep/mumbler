import type { ReactElement } from "react";

import type { CommandDefinition, CommandId } from "@shared/app-shell";

export function ShortcutsHelpModal({
  commands,
  shortcuts,
  onClose,
}: {
  commands: CommandDefinition[];
  shortcuts: Record<CommandId, string>;
  onClose: () => void;
}): ReactElement {
  return (
    <div className="modal-backdrop">
      <section className="modal-card modal-card--narrow">
        <div className="modal-card__header">
          <h2>Keyboard Shortcuts</h2>
        </div>
        <div className="shortcut-list">
          {commands.map((command) => (
            <div key={command.id} className="shortcut-item">
              <span>{command.label}</span>
              <kbd>{shortcuts[command.id] ?? "—"}</kbd>
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button type="button" className="button button--primary" onClick={onClose}>
            Close
          </button>
        </div>
      </section>
    </div>
  );
}
