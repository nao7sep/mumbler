import type { ReactElement } from "react";

import type { CommandDefinition } from "@shared/app-shell";
import { COMMAND_DEFINITIONS } from "@shared/commands";

import { ModalShell } from "./modal/ModalShell";
import { useI18n } from "../i18n/I18nContext";

// event.key → the display word the keyboard-shortcut-conventions prescribe
// (full key names, symbols spelled out); bare letters just uppercase. Tokens
// name the keycaps, which are printed in English, so they stay English in
// every interface language.
const KEY_DISPLAY: Record<string, string> = {
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  " ": "Space",
  "[": "Left Bracket",
  "]": "Right Bracket",
};

function helpChord(): string {
  return `${/Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent) ? "Cmd" : "Ctrl"}+Slash`;
}

function formatShortcutKey(key: string): string {
  return KEY_DISPLAY[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

export function ShortcutsHelpModal({ onClose }: { onClose: () => void }): ReactElement {
  const { t } = useI18n();
  const groups = COMMAND_DEFINITIONS.reduce<Array<{ name: CommandDefinition["groupKey"]; commands: CommandDefinition[] }>>(
    (acc, command) => {
      const existing = acc.find((g) => g.name === command.groupKey);
      if (existing) {
        existing.commands.push(command);
      } else {
        acc.push({ name: command.groupKey, commands: [command] });
      }
      return acc;
    },
    [],
  );

  return (
    <ModalShell
      title={t("shortcuts.title")}
      size="narrow"
      onRequestClose={onClose}
      footer={
        <button type="button" className="button button--ghost" onClick={onClose}>
          {t("common.close")}
        </button>
      }
    >
      <div className="modal-card__body">
        <div className="shortcut-groups">
          {groups.map((group) => (
            <div key={group.name} className="shortcut-group">
              <p className="shortcut-group__name">{t(group.name)}</p>
              <div className="shortcut-list">
                {group.commands.map((command) => (
                  <div key={command.id} className="shortcut-item">
                    <span>{t(command.labelKey)}</span>
                    <kbd>{formatShortcutKey(command.key)}</kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div className="shortcut-group">
            <p className="shortcut-group__name">{t("shortcuts.helpGroup")}</p>
            <div className="shortcut-list">
              <div className="shortcut-item">
                <span>{t("shortcuts.showList")}</span>
                {/* The running platform's single word (keyboard-shortcut-conventions);
                    the chord is bound in App.tsx, outside COMMAND_DEFINITIONS,
                    because it opens a modal rather than firing a command. */}
                <kbd>{helpChord()}</kbd>
              </div>
            </div>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
