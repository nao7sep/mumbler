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
    <ModalShell
      title="Keyboard Shortcuts"
      size="narrow"
      onRequestClose={onClose}
      footer={
        <button type="button" className="button button--ghost" onClick={onClose}>
          Close
        </button>
      }
    >
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
          <div className="shortcut-group">
            <p className="shortcut-group__name">Help</p>
            <div className="shortcut-list">
              <div className="shortcut-item">
                <span>Show this list</span>
                {/* The running platform's single word (keyboard-shortcut-conventions);
                    the chord is bound in App.tsx, outside COMMAND_DEFINITIONS,
                    because it opens a modal rather than firing a command. */}
                <kbd>{/Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent) ? "Cmd" : "Ctrl"}+Slash</kbd>
              </div>
            </div>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
