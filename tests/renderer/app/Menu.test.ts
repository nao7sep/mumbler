// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Menu, MenuItem } from "@renderer/app/Menu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

// The Menu is controlled (open / onOpenChange), so the test owns the open state in
// a tiny wrapper — the same way App.tsx does.
function ControlledMenu(props: { onSelect: { a: () => void; b: () => void; c: () => void }; disabled?: string[] }) {
  const [open, setOpen] = useState(false);
  return React.createElement(Menu, {
    open,
    onOpenChange: setOpen,
    label: "Test menu",
    trigger: (triggerProps: Record<string, unknown>) =>
      React.createElement("button", { ...triggerProps, "data-testid": "trigger" }, "Open"),
    children: [
      React.createElement(MenuItem, { onSelect: props.onSelect.a, disabled: props.disabled?.includes("a"), key: "a", children: "Apple" }),
      React.createElement(MenuItem, { onSelect: props.onSelect.b, disabled: props.disabled?.includes("b"), key: "b", children: "Banana" }),
      React.createElement(MenuItem, { onSelect: props.onSelect.c, disabled: props.disabled?.includes("c"), key: "c", children: "Cherry" }),
    ],
  });
}

async function mountMenu(onSelect: { a: () => void; b: () => void; c: () => void }, disabled: string[] = []): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(React.createElement(ControlledMenu, { onSelect, disabled }));
  });
}

const trigger = () => document.querySelector('[data-testid="trigger"]') as HTMLButtonElement;
const menu = () => document.querySelector('[role="menu"]') as HTMLElement | null;
const items = () => Array.from(document.querySelectorAll('[role="menuitem"]')) as HTMLElement[];

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function key(
  el: HTMLElement,
  k: string,
  init: Partial<KeyboardEventInit> = {},
): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...init }));
  });
}

// The menu opens focus into the first item via requestAnimationFrame; flush it.
async function flushOpenFocus(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("Menu", () => {
  it("marks the trigger as a menu opener", async () => {
    await mountMenu({ a: vi.fn(), b: vi.fn(), c: vi.fn() });
    expect(trigger().getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(menu()).toBeNull();
  });

  it("opens on trigger click and exposes the items as menuitems with no tab stop", async () => {
    await mountMenu({ a: vi.fn(), b: vi.fn(), c: vi.fn() });
    await click(trigger());
    expect(menu()).not.toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(items().map((i) => i.textContent)).toEqual(["Apple", "Banana", "Cherry"]);
    expect(items().every((i) => i.getAttribute("tabindex") === "-1")).toBe(true);
  });

  it("moves focus to the first item on open", async () => {
    await mountMenu({ a: vi.fn(), b: vi.fn(), c: vi.fn() });
    await click(trigger());
    await flushOpenFocus();
    expect(document.activeElement).toBe(items()[0]);
  });

  it("moves focus with Down/Up (stopping at the ends) and Home/End", async () => {
    await mountMenu({ a: vi.fn(), b: vi.fn(), c: vi.fn() });
    await click(trigger());
    await flushOpenFocus(); // settle the open-focus rAF so it can't clobber arrow navigation
    await key(items()[0], "ArrowDown");
    expect(document.activeElement).toBe(items()[1]);
    await key(items()[1], "End");
    expect(document.activeElement).toBe(items()[2]);
    await key(items()[2], "ArrowDown"); // stops at the last item
    expect(document.activeElement).toBe(items()[2]);
    await key(items()[2], "Home");
    expect(document.activeElement).toBe(items()[0]);
    await key(items()[0], "ArrowUp"); // stops at the first item
    expect(document.activeElement).toBe(items()[0]);
  });

  it("opens at the first enabled command and skips disabled ends and type-ahead targets", async () => {
    const onSelect = { a: vi.fn(), b: vi.fn(), c: vi.fn() };
    await mountMenu(onSelect, ["a", "c"]);
    await click(trigger());
    await flushOpenFocus();
    expect(document.activeElement).toBe(items()[1]);
    for (const name of ["Home", "End", "ArrowUp", "ArrowDown", "a", "c"]) {
      await key(document.activeElement as HTMLElement, name);
      expect(document.activeElement).toBe(items()[1]);
    }
    await key(items()[1], "Enter");
    expect(onSelect.b).toHaveBeenCalledOnce();
    expect(onSelect.a).not.toHaveBeenCalled();
    expect(onSelect.c).not.toHaveBeenCalled();
  });

  it("excludes nonfocusable, hidden, inert and aria-disabled items from keyboard targets", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(React.createElement(Menu, {
      open: true, onOpenChange: vi.fn(), label: "Test menu",
      trigger: (props) => React.createElement("button", props, "Open"),
      children: [
        React.createElement("span", { role: "menuitem", key: "label" }, "Apple label"),
        React.createElement("button", { role: "menuitem", "aria-disabled": true, key: "disabled" }, "Apple unavailable"),
        React.createElement("button", { role: "menuitem", hidden: true, key: "hidden" }, "Apple hidden"),
        React.createElement("div", { inert: true, key: "inert" }, React.createElement("button", { role: "menuitem" }, "Apple inert")),
        React.createElement(MenuItem, { onSelect: vi.fn(), key: "enabled", children: "Banana" }),
      ],
    })));
    await flushOpenFocus();
    const enabled = items().at(-1)!;
    expect(document.activeElement).toBe(enabled);
    await key(enabled, "Home");
    await key(enabled, "a");
    expect(document.activeElement).toBe(enabled);
  });

  it("arrows past disabled commands in the middle", async () => {
    await mountMenu({ a: vi.fn(), b: vi.fn(), c: vi.fn() }, ["b"]);
    await click(trigger());
    await flushOpenFocus();
    await key(items()[0], "ArrowDown");
    expect(document.activeElement).toBe(items()[2]);
    await key(items()[2], "ArrowUp");
    expect(document.activeElement).toBe(items()[0]);
  });

  it.each(["Escape", "Tab"])("keeps an all-disabled menu dismissible with %s", async (dismiss) => {
    const onSelect = { a: vi.fn(), b: vi.fn(), c: vi.fn() };
    await mountMenu(onSelect, ["a", "b", "c"]);
    await click(trigger());
    await flushOpenFocus();
    expect(document.activeElement).toBe(menu());
    for (const name of ["Home", "End", "ArrowUp", "ArrowDown", "a", "Enter", " "]) {
      await key(menu()!, name);
      expect(document.activeElement).toBe(menu());
    }
    expect(Object.values(onSelect).every((action) => action.mock.calls.length === 0)).toBe(true);
    await key(menu()!, dismiss);
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("Escape closes the menu and returns focus to the trigger", async () => {
    await mountMenu({ a: vi.fn(), b: vi.fn(), c: vi.fn() });
    await click(trigger());
    items()[0].focus();
    await key(items()[0], "Escape");
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("Tab closes the menu and returns focus to the trigger", async () => {
    await mountMenu({ a: vi.fn(), b: vi.fn(), c: vi.fn() });
    await click(trigger());
    items()[0].focus();
    await key(items()[0], "Tab");
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("clicking an item runs its action and closes the menu", async () => {
    const onSelect = { a: vi.fn(), b: vi.fn(), c: vi.fn() };
    await mountMenu(onSelect);
    await click(trigger());
    await click(items()[1]);
    expect(onSelect.b).toHaveBeenCalledOnce();
    expect(onSelect.a).not.toHaveBeenCalled();
    expect(menu()).toBeNull();
  });

  it("Enter activates the focused item and closes the menu", async () => {
    const onSelect = { a: vi.fn(), b: vi.fn(), c: vi.fn() };
    await mountMenu(onSelect);
    await click(trigger());
    await flushOpenFocus(); // settle the open-focus rAF so it can't re-focus item 0
    items()[1].focus();
    await key(items()[1], "Enter");
    expect(onSelect.b).toHaveBeenCalledOnce();
    expect(menu()).toBeNull();
  });

  // Hover is a pointer cue, never the keyboard target (composite-control-conventions):
  // after arrowing down, resting the pointer on an earlier item must not move where
  // the next arrow or Enter acts.
  it("keeps the keyboard target when the pointer hovers an earlier item", async () => {
    const onSelect = { a: vi.fn(), b: vi.fn(), c: vi.fn() };
    await mountMenu(onSelect);
    await click(trigger());
    await flushOpenFocus();
    await key(items()[0], "ArrowDown");
    await key(items()[1], "ArrowDown");
    expect(document.activeElement).toBe(items()[2]);
    const hover = async (el: HTMLElement) => {
      await act(async () => {
        for (const type of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]) {
          el.dispatchEvent(new MouseEvent(type, { bubbles: true }));
        }
      });
    };
    await hover(items()[0]);
    expect(document.activeElement).toBe(items()[2]);
    await key(document.activeElement as HTMLElement, "ArrowUp");
    expect(document.activeElement).toBe(items()[1]);
    await hover(items()[0]);
    await key(document.activeElement as HTMLElement, "Enter");
    expect(onSelect.b).toHaveBeenCalledOnce();
    expect(onSelect.a).not.toHaveBeenCalled();
  });

  it("type-ahead jumps to the next item whose label starts with the key", async () => {
    await mountMenu({ a: vi.fn(), b: vi.fn(), c: vi.fn() });
    await click(trigger());
    await flushOpenFocus(); // settle the open-focus rAF first, or it can re-focus item 0 and clobber the type-ahead jump (flaked in CI)
    await key(items()[0], "c");
    expect(document.activeElement).toBe(items()[2]); // "Cherry"
  });

  it("ignores type-ahead while an IME composition is in progress", async () => {
    await mountMenu({ a: vi.fn(), b: vi.fn(), c: vi.fn() });
    await click(trigger());
    await flushOpenFocus(); // settle the open-focus rAF so it can't clobber focus below
    // With isComposing the printable key belongs to the IME and must NOT move focus.
    await key(items()[0], "c", { isComposing: true });
    expect(document.activeElement).toBe(items()[0]);
    // Without it, the same key jumps as normal.
    await key(items()[0], "c");
    expect(document.activeElement).toBe(items()[2]);
  });
});
