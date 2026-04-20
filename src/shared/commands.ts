import type { CommandDefinition, CommandId } from "./app-shell";

export const COMMAND_DEFINITIONS: CommandDefinition[] = [
  { id: "play-pause", label: "Play / Pause", defaultShortcut: "Space" },
  { id: "set-front-marker", label: "Set Front Marker", defaultShortcut: "F" },
  { id: "set-back-marker", label: "Set Back Marker", defaultShortcut: "B" },
  { id: "play-first-snippet", label: "Play First N Seconds", defaultShortcut: "[" },
  { id: "play-last-snippet", label: "Play Last N Seconds", defaultShortcut: "]" },
  { id: "transcribe-selected", label: "Transcribe Selected", defaultShortcut: "T" },
  { id: "save-selected", label: "Save Selected", defaultShortcut: "S" },
  { id: "retry-selected", label: "Retry Selected", defaultShortcut: "R" },
  { id: "remove-selected", label: "Remove Selected", defaultShortcut: "Del" },
  { id: "select-previous", label: "Select Previous Card", defaultShortcut: "Up" },
  { id: "select-next", label: "Select Next Card", defaultShortcut: "Down" },
];

export function buildDefaultShortcutMap(): Record<CommandId, string> {
  return COMMAND_DEFINITIONS.reduce(
    (accumulator, command) => {
      accumulator[command.id] = command.defaultShortcut;
      return accumulator;
    },
    {} as Record<CommandId, string>,
  );
}

