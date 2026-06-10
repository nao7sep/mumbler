import type { ReactElement } from "react";

import type { CommandDefinition } from "@shared/app-shell";
import { COMMAND_DEFINITIONS } from "@shared/commands";

import { ModalShell } from "./modal/ModalShell";

const KEY_SYMBOLS: Record<string, string> = {
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  Up: "Up",
  Down: "Down",
  "[": "Left Bracket",
  "]": "Right Bracket",
};

function formatShortcutKey(key: string): string {
  return KEY_SYMBOLS[key] ?? key;
}

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
    <ModalShell title="Keyboard Shortcuts" size="narrow" onRequestClose={onClose}>
      <div className="modal-card__body">
        <div className="shortcut-groups">
          {groups.map((group) => (
            <div key={group.name} className="shortcut-group">
              <p className="shortcut-group__name">{group.name}</p>
              <div className="shortcut-list">
                {group.commands.map((command) => (
                  <div key={command.id} className="shortcut-item">
                    <span>{command.label}</span>
                    <kbd>{formatShortcutKey(command.defaultShortcut)}</kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </ModalShell>
  );
}
