// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import type { CommandId } from "@shared/app-shell";
import { COMMAND_DEFINITIONS } from "@shared/commands";
import { findMatchingGlobalCommand, isTextEditingTarget, isTypingTarget } from "@renderer/app/shortcut-utils";

function keydown(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

describe("findMatchingGlobalCommand", () => {
  it("leaves queue navigation to the focused listbox and matches playback keys", () => {
    expect(findMatchingGlobalCommand(keydown({ key: "ArrowUp" }))).toBeNull();
    expect(findMatchingGlobalCommand(keydown({ key: "ArrowDown" }))).toBeNull();
    expect(findMatchingGlobalCommand(keydown({ key: " " }))).toBe("play-pause");
    expect(findMatchingGlobalCommand(keydown({ key: "ArrowLeft" }))).toBe("skip-backward");
    expect(findMatchingGlobalCommand(keydown({ key: "ArrowRight" }))).toBe("skip-forward");
  });

  it("matches the single-letter trim and workflow keys", () => {
    expect(findMatchingGlobalCommand(keydown({ key: "f" }))).toBe("set-front-marker");
    expect(findMatchingGlobalCommand(keydown({ key: "b" }))).toBe("set-back-marker");
    expect(findMatchingGlobalCommand(keydown({ key: "t" }))).toBe("transcribe-selected");
    expect(findMatchingGlobalCommand(keydown({ key: "s" }))).toBe("save-selected");
  });

  it("does not match when an unexpected modifier is held", () => {
    expect(findMatchingGlobalCommand(keydown({ key: "s", ctrlKey: true }))).toBeNull();
    expect(findMatchingGlobalCommand(keydown({ key: "s", metaKey: true }))).toBeNull();
    expect(findMatchingGlobalCommand(keydown({ key: "f", altKey: true }))).toBeNull();
  });

  it("returns null for keys with no bound command", () => {
    expect(findMatchingGlobalCommand(keydown({ key: "z" }))).toBeNull();
    expect(findMatchingGlobalCommand(keydown({ key: "Enter" }))).toBeNull();
  });

  it("matches the bracket keys to the snippet-preview commands", () => {
    expect(findMatchingGlobalCommand(keydown({ key: "[" }))).toBe("play-first-snippet");
    expect(findMatchingGlobalCommand(keydown({ key: "]" }))).toBe("play-last-snippet");
  });

  // Regression guard: every defined command must be reachable by the physical
  // key a user actually presses (the event.key browsers/Electron emit). The
  // coverage assertion fails if a command is added without a key mapping here,
  // so no shortcut can silently become undispatchable.
  it("maps every defined command to a reachable physical key", () => {
    const keyForCommand: Record<CommandId, string> = {
      "select-previous": "ArrowUp",
      "select-next": "ArrowDown",
      "play-pause": " ",
      "skip-backward": "ArrowLeft",
      "skip-forward": "ArrowRight",
      "play-first-snippet": "[",
      "play-last-snippet": "]",
      "set-front-marker": "f",
      "set-back-marker": "b",
      "transcribe-selected": "t",
      "save-selected": "s",
    };

    for (const command of COMMAND_DEFINITIONS) {
      const expected = command.group === "Queue" ? null : command.id;
      expect(findMatchingGlobalCommand(keydown({ key: keyForCommand[command.id] }))).toBe(expected);
    }

    expect(Object.keys(keyForCommand).sort()).toEqual(
      COMMAND_DEFINITIONS.map((command) => command.id).sort(),
    );
  });
});

describe("isTypingTarget", () => {
  it("treats text fields and contenteditable as typing targets", () => {
    expect(isTypingTarget(document.createElement("input"))).toBe(true);
    expect(isTypingTarget(document.createElement("textarea"))).toBe(true);
    // Select owns keyboard type-ahead, so the global bare-key commands stand down.
    expect(isTypingTarget(document.createElement("select"))).toBe(true);

    // jsdom does not implement the live isContentEditable getter, so stub it to
    // exercise the branch in isTypingTarget directly.
    const editable = document.createElement("div");
    Object.defineProperty(editable, "isContentEditable", { value: true });
    expect(isTypingTarget(editable)).toBe(true);
  });

  it("treats other elements and null as non-typing targets", () => {
    expect(isTypingTarget(document.createElement("div"))).toBe(false);
    expect(isTypingTarget(document.createElement("button"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("isTextEditingTarget", () => {
  it("distinguishes native text editors from other shortcut-owning inputs", () => {
    expect(isTextEditingTarget(document.createElement("textarea"))).toBe(true);
    expect(isTextEditingTarget(document.createElement("input"))).toBe(true);
    const range = document.createElement("input");
    range.type = "range";
    expect(isTextEditingTarget(range)).toBe(false);
    expect(isTypingTarget(range)).toBe(true);
  });
});
