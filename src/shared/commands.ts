import type { CommandDefinition } from "./app-shell";

// `key` is the literal event.key the command matches (letters lowercase; the
// owning interaction layer lowercases the event's letter so CapsLock cannot kill
// a command). Queue arrows are displayed here but dispatched by the listbox;
// the remaining commands are dispatched by the window command layer.
// The help modal derives the display word from it per the
// keyboard-shortcut-conventions ("ArrowUp" → "Up", " " → "Space").
export const COMMAND_DEFINITIONS: CommandDefinition[] = [
  // Queue navigation
  { id: "select-previous",    labelKey: "command.selectPrevious", groupKey: "commandGroup.queue",    key: "ArrowUp" },
  { id: "select-next",        labelKey: "command.selectNext",     groupKey: "commandGroup.queue",    key: "ArrowDown" },
  // Playback
  { id: "play-pause",         labelKey: "command.playPause",              groupKey: "commandGroup.playback", key: " " },
  { id: "skip-backward",      labelKey: "command.skipBackward",             groupKey: "commandGroup.playback", key: "ArrowLeft" },
  { id: "skip-forward",       labelKey: "command.skipForward",              groupKey: "commandGroup.playback", key: "ArrowRight" },
  { id: "play-first-snippet", labelKey: "command.playFirstSnippet",      groupKey: "commandGroup.playback", key: "[" },
  { id: "play-last-snippet",  labelKey: "command.playLastSnippet",       groupKey: "commandGroup.playback", key: "]" },
  // Trim
  { id: "set-front-marker",   labelKey: "command.setFrontMarker",          groupKey: "commandGroup.trim",     key: "f" },
  { id: "set-back-marker",    labelKey: "command.setBackMarker",           groupKey: "commandGroup.trim",     key: "b" },
  // Workflow
  { id: "transcribe-selected", labelKey: "command.generateAll",             groupKey: "commandGroup.workflow", key: "t" },
  { id: "save-selected",       labelKey: "command.save",                     groupKey: "commandGroup.workflow", key: "s" },
];
