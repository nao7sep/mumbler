import type { CommandId } from "@shared/app-shell";
import { COMMAND_DEFINITIONS } from "@shared/commands";

import { isImeKeyEvent } from "./useComposing";

const TEXT_INPUT_TYPES = new Set([
  "",
  "email",
  "number",
  "password",
  "search",
  "tel",
  "text",
  "url",
]);

/**
 * Every mumbler command is a bare key: any modifier means the keystroke is
 * something else (a chord, typed punctuation, AltGr output) and no command
 * fires. Letters compare case-insensitively so a stray CapsLock cannot kill
 * the trim keys; Shift is still rejected as a held modifier.
 */
export function findMatchingGlobalCommand(event: KeyboardEvent): CommandId | null {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
    return null;
  }
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  for (const command of COMMAND_DEFINITIONS) {
    if (command.id === "select-previous" || command.id === "select-next") continue;
    if (command.key === key) {
      return command.id;
    }
  }
  return null;
}

/**
 * Cmd/Ctrl+Slash opens the shortcuts help (the fleet's conventional help
 * chord). Alt is excluded so Windows AltGr — delivered as Ctrl+Alt — keeps
 * typing characters. On macOS the Ctrl half stands down while the target takes
 * typed text — Ctrl belongs to the text system there — and the Cmd half is the
 * binding (keyboard-shortcut-conventions). Never while an IME composition is in
 * progress: opening the help moves focus and would tear the composition down
 * (text-input-ime-conventions).
 */
export function isShortcutsHelpChord(event: KeyboardEvent, isMac: boolean): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    event.key === "/" &&
    !(isMac && event.ctrlKey && !event.metaKey && isTextEditingTarget(event.target)) &&
    !isImeKeyEvent(event)
  );
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
  if (tagName === "textarea") return true;
  return tagName === "input" && TEXT_INPUT_TYPES.has(target.getAttribute("type")?.toLowerCase() ?? "");
}

/** Keyboard-owning targets for the global bare-key commands: text entry and
 * native input/select controls whose own key behavior must take precedence. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (isTextEditingTarget(target)) {
    return true;
  }
  return target instanceof HTMLElement && ["input", "select"].includes(target.tagName.toLowerCase());
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
