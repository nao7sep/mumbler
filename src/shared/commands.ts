import type { CommandDefinition } from "./app-shell";

// `keys` lists the literal event.key values the command matches (letters
// lowercase; the owning interaction layer lowercases the event's letter so
// CapsLock cannot kill a command). Queue arrows are displayed here but
// dispatched by the listbox; the remaining commands are dispatched by the
// window command layer. The help modal derives the display word from each
// entry per the keyboard-shortcut-conventions ("ArrowUp" → "Up", " " → "Space").
// Skip-backward/forward also bind YouTube's J/L seek keys alongside the
// arrows (keyboard-shortcut-conventions: "prefer keys people already know").
export const COMMAND_DEFINITIONS: CommandDefinition[] = [
  // Queue navigation
  { id: "select-previous",    labelKey: "command.selectPrevious", groupKey: "commandGroup.queue",    keys: ["ArrowUp"] },
  { id: "select-next",        labelKey: "command.selectNext",     groupKey: "commandGroup.queue",    keys: ["ArrowDown"] },
  // Playback
  { id: "play-pause",         labelKey: "command.playPause",              groupKey: "commandGroup.playback", keys: [" "] },
  { id: "skip-backward",      labelKey: "command.skipBackward",             groupKey: "commandGroup.playback", keys: ["ArrowLeft", "j"] },
  { id: "skip-forward",       labelKey: "command.skipForward",              groupKey: "commandGroup.playback", keys: ["ArrowRight", "l"] },
  { id: "play-first-snippet", labelKey: "command.playFirstSnippet",      groupKey: "commandGroup.playback", keys: ["["] },
  { id: "play-last-snippet",  labelKey: "command.playLastSnippet",       groupKey: "commandGroup.playback", keys: ["]"] },
  // Trim
  { id: "set-front-marker",   labelKey: "command.setFrontMarker",          groupKey: "commandGroup.trim",     keys: ["f"] },
  { id: "set-back-marker",    labelKey: "command.setBackMarker",           groupKey: "commandGroup.trim",     keys: ["b"] },
  // Workflow
  { id: "transcribe-selected", labelKey: "command.generateAll",             groupKey: "commandGroup.workflow", keys: ["t"] },
  { id: "save-selected",       labelKey: "command.save",                     groupKey: "commandGroup.workflow", keys: ["s"] },
];
