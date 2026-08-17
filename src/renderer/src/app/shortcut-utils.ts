import type { CommandId } from "@shared/app-shell";
import { COMMAND_DEFINITIONS } from "@shared/commands";

/**
 * Every mumbler command is a bare key: any modifier means the keystroke is
 * something else (a chord, typed punctuation, AltGr output) and no command
 * fires. Letters compare case-insensitively so a stray CapsLock cannot kill
 * the trim keys; Shift is still rejected as a held modifier.
 */
export function findMatchingCommand(event: KeyboardEvent): CommandId | null {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
    return null;
  }
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  for (const command of COMMAND_DEFINITIONS) {
    if (command.key === key) {
      return command.id;
    }
  }
  return null;
}

/** Text-entry targets — where the macOS text system owns the Ctrl half of a
 * dual-bound chord (keyboard-shortcut-conventions). */
export function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea";
}

/** Keyboard-owning targets for the global bare-key commands: text entry, plus a
 * native select — it owns printable-key type-ahead even though it is not a text
 * editor, so bare keys must still stand down while it has focus. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (isTextEditingTarget(target)) {
    return true;
  }
  return target instanceof HTMLElement && target.tagName.toLowerCase() === "select";
}

// True when the focused element activates on Space (a button, link, or summary).
// A global single-key shortcut must not preventDefault Space over such a control,
// or the Space the user pressed to click the button they tabbed to would instead
// fire the global command (e.g. play/pause).
export function isActivationTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tagName = target.tagName.toLowerCase();
  if (tagName === "button" || tagName === "summary") {
    return true;
  }
  if (tagName === "a" && target.hasAttribute("href")) {
    return true;
  }
  return target.getAttribute("role") === "button";
}
