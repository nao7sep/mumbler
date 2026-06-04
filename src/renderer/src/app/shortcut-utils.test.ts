// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import type { CommandId } from "@shared/app-shell";
import { COMMAND_DEFINITIONS } from "@shared/commands";
import { findMatchingCommand, isTypingTarget } from "./shortcut-utils";

function keydown(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

describe("findMatchingCommand", () => {
  it("matches the unmodified navigation and playback keys", () => {
    expect(findMatchingCommand(keydown({ key: "ArrowUp" }))).toBe("select-previous");
    expect(findMatchingCommand(keydown({ key: "ArrowDown" }))).toBe("select-next");
    expect(findMatchingCommand(keydown({ key: " " }))).toBe("play-pause");
    expect(findMatchingCommand(keydown({ key: "ArrowLeft" }))).toBe("skip-backward");
    expect(findMatchingCommand(keydown({ key: "ArrowRight" }))).toBe("skip-forward");
  });

  it("matches the single-letter trim and workflow keys", () => {
    expect(findMatchingCommand(keydown({ key: "f" }))).toBe("set-front-marker");
    expect(findMatchingCommand(keydown({ key: "b" }))).toBe("set-back-marker");
    expect(findMatchingCommand(keydown({ key: "t" }))).toBe("transcribe-selected");
    expect(findMatchingCommand(keydown({ key: "s" }))).toBe("save-selected");
  });

  it("does not match when an unexpected modifier is held", () => {
    expect(findMatchingCommand(keydown({ key: "s", ctrlKey: true }))).toBeNull();
    expect(findMatchingCommand(keydown({ key: "s", metaKey: true }))).toBeNull();
    expect(findMatchingCommand(keydown({ key: "f", altKey: true }))).toBeNull();
  });

  it("returns null for keys with no bound command", () => {
    expect(findMatchingCommand(keydown({ key: "z" }))).toBeNull();
    expect(findMatchingCommand(keydown({ key: "Enter" }))).toBeNull();
  });

  it("matches the bracket keys to the snippet-preview commands", () => {
    expect(findMatchingCommand(keydown({ key: "[" }))).toBe("play-first-snippet");
    expect(findMatchingCommand(keydown({ key: "]" }))).toBe("play-last-snippet");
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
      expect(findMatchingCommand(keydown({ key: keyForCommand[command.id] }))).toBe(command.id);
    }

    expect(Object.keys(keyForCommand).sort()).toEqual(
      COMMAND_DEFINITIONS.map((command) => command.id).sort(),
    );
  });
});

describe("isTypingTarget", () => {
  it("treats form fields and contenteditable as typing targets", () => {
    expect(isTypingTarget(document.createElement("input"))).toBe(true);
    expect(isTypingTarget(document.createElement("textarea"))).toBe(true);
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
