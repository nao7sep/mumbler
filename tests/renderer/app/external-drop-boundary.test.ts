// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { denyUnhandledExternalDrop } from "@renderer/app/external-drop-boundary";

describe("external drop boundary", () => {
  it("denies unowned data without overriding the Queue importer", () => {
    const unowned = {
      defaultPrevented: false,
      preventDefault(this: { defaultPrevented: boolean }) {
        this.defaultPrevented = true;
      },
      dataTransfer: { dropEffect: "copy" },
    } as unknown as DragEvent;
    denyUnhandledExternalDrop(unowned);
    expect(unowned.defaultPrevented).toBe(true);
    expect(unowned.dataTransfer?.dropEffect).toBe("none");

    const owned = {
      defaultPrevented: true,
      preventDefault() {},
      dataTransfer: { dropEffect: "copy" },
    } as unknown as DragEvent;
    denyUnhandledExternalDrop(owned);
    expect(owned.dataTransfer?.dropEffect).toBe("copy");

    const editableFileItem = {
      defaultPrevented: false,
      preventDefault(this: { defaultPrevented: boolean }) {
        this.defaultPrevented = true;
      },
      target: { closest: () => ({}) },
      dataTransfer: { types: [], items: [{ kind: "file" }], dropEffect: "copy" },
    } as unknown as DragEvent;
    denyUnhandledExternalDrop(editableFileItem);
    expect(editableFileItem.defaultPrevented).toBe(true);
  });
});
