import type { CommandDefinition } from "./app-shell";

export const COMMAND_DEFINITIONS: CommandDefinition[] = [
  // Queue navigation
  { id: "select-previous",    label: "Select Previous Recording", group: "Queue",    defaultShortcut: "Up" },
  { id: "select-next",        label: "Select Next Recording",     group: "Queue",    defaultShortcut: "Down" },
  // Playback
  { id: "play-pause",         label: "Play / Pause",              group: "Playback", defaultShortcut: "Space" },
  { id: "play-first-snippet", label: "Play First N Seconds",      group: "Playback", defaultShortcut: "[" },
  { id: "play-last-snippet",  label: "Play Last N Seconds",       group: "Playback", defaultShortcut: "]" },
  // Trim
  { id: "set-front-marker",   label: "Set Front Marker",          group: "Trim",     defaultShortcut: "F" },
  { id: "set-back-marker",    label: "Set Back Marker",           group: "Trim",     defaultShortcut: "B" },
  // Workflow
  { id: "transcribe-selected", label: "Generate All",             group: "Workflow", defaultShortcut: "T" },
  { id: "save-selected",       label: "Save",                     group: "Workflow", defaultShortcut: "S" },
];
