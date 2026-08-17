import type { CommandDefinition } from "./app-shell";

// `key` is the literal event.key the command matches (letters lowercase; the
// dispatcher lowercases the event's letter so CapsLock cannot kill a command).
// The help modal derives the display word from it per the
// keyboard-shortcut-conventions ("ArrowUp" → "Up", " " → "Space").
export const COMMAND_DEFINITIONS: CommandDefinition[] = [
  // Queue navigation
  { id: "select-previous",    label: "Select Previous Recording", group: "Queue",    key: "ArrowUp" },
  { id: "select-next",        label: "Select Next Recording",     group: "Queue",    key: "ArrowDown" },
  // Playback
  { id: "play-pause",         label: "Play / Pause",              group: "Playback", key: " " },
  { id: "skip-backward",      label: "Skip Backward",             group: "Playback", key: "ArrowLeft" },
  { id: "skip-forward",       label: "Skip Forward",              group: "Playback", key: "ArrowRight" },
  { id: "play-first-snippet", label: "Play First N Seconds",      group: "Playback", key: "[" },
  { id: "play-last-snippet",  label: "Play Last N Seconds",       group: "Playback", key: "]" },
  // Trim
  { id: "set-front-marker",   label: "Set Front Marker",          group: "Trim",     key: "f" },
  { id: "set-back-marker",    label: "Set Back Marker",           group: "Trim",     key: "b" },
  // Workflow
  { id: "transcribe-selected", label: "Generate All",             group: "Workflow", key: "t" },
  { id: "save-selected",       label: "Save",                     group: "Workflow", key: "s" },
];
