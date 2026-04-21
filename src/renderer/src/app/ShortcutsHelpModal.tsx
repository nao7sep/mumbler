import type { ReactElement } from "react";

import type { CommandDefinition } from "@shared/app-shell";
import { COMMAND_DEFINITIONS } from "@shared/commands";

export function ShortcutsHelpModal({ onClose }: { onClose: () => void }): ReactElement {
  const groups = COMMAND_DEFINITIONS.reduce<Array<{ name: string; commands: CommandDefinition[] }>>(
    (acc, command) => {
      const existing = acc.find((g) => g.name === command.group);
      if (existing) {
        existing.commands.push(command);
      } else {
        acc.push({ name: command.group, commands: [command] });
      }
      return acc;
    },
    [],
  );

  return (
    <div className="modal-backdrop">
      <section className="modal-card modal-card--narrow">
        <div className="modal-card__header">
          <h2>Keyboard Shortcuts</h2>
        </div>
        <div className="shortcut-groups">
          {groups.map((group) => (
            <div key={group.name} className="shortcut-group">
              <p className="shortcut-group__name">{group.name}</p>
              <div className="shortcut-list">
                {group.commands.map((command) => (
                  <div key={command.id} className="shortcut-item">
                    <span>{command.label}</span>
                    <kbd>{command.defaultShortcut}</kbd>
                  </div>
                ))}
              </div>
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
