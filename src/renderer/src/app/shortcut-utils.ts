import type { CommandId } from "@shared/app-shell";

const modifierAliases: Record<string, "ctrl" | "alt" | "shift" | "meta"> = {
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  shift: "shift",
  cmd: "meta",
  command: "meta",
  meta: "meta",
  super: "meta",
};

const keyAliases: Record<string, string> = {
  space: "space",
  " ": "space",
  del: "del",
  delete: "del",
  up: "up",
  arrowup: "up",
  down: "down",
  arrowdown: "down",
  left: "left",
  arrowleft: "left",
  right: "right",
  arrowright: "right",
  esc: "escape",
  escape: "escape",
};

interface ParsedShortcut {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export function findMatchingCommand(
  event: KeyboardEvent,
  shortcuts: Record<CommandId, string>,
): CommandId | null {
  const eventShortcut = normalizeKeyboardEvent(event);
  if (eventShortcut === null) {
    return null;
  }

  for (const [commandId, shortcut] of Object.entries(shortcuts) as Array<[CommandId, string]>) {
    const parsedShortcut = parseShortcut(shortcut);
    if (parsedShortcut === null) {
      continue;
    }

    if (
      parsedShortcut.key === eventShortcut.key &&
      parsedShortcut.ctrl === eventShortcut.ctrl &&
      parsedShortcut.alt === eventShortcut.alt &&
      parsedShortcut.shift === eventShortcut.shift &&
      parsedShortcut.meta === eventShortcut.meta
    ) {
      return commandId;
    }
  }

  return null;
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select";
}

function parseShortcut(value: string): ParsedShortcut | null {
  const parts = value
    .split("+")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);

  if (parts.length === 0) {
    return null;
  }

  const parsed: ParsedShortcut = {
    key: "",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
  };

  for (const part of parts) {
    const modifier = modifierAliases[part];
    if (modifier) {
      parsed[modifier] = true;
      continue;
    }

    if (parsed.key.length > 0) {
      return null;
    }

    parsed.key = normalizeKeyToken(part);
  }

  return parsed.key.length > 0 ? parsed : null;
}

function normalizeKeyboardEvent(event: KeyboardEvent): ParsedShortcut | null {
  const key = normalizeKeyToken(event.key);
  if (key.length === 0) {
    return null;
  }

  return {
    key,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
  };
}

function normalizeKeyToken(value: string): string {
  const normalized = value.toLowerCase();
  if (keyAliases[normalized]) {
    return keyAliases[normalized];
  }

  if (normalized.length === 1) {
    return normalized;
  }

  return normalized;
}
