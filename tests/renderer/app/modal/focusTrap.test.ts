// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { getFocusableElements, trapTabFocus } from "@renderer/app/modal/focusTrap";

function mountCard(innerHtml: string): HTMLElement {
  const card = document.createElement("section");
  card.tabIndex = -1;
  card.innerHTML = innerHtml;
  document.body.append(card);
  return card;
}

function tabEvent(shiftKey = false): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key: "Tab",
    shiftKey,
    cancelable: true,
    bubbles: true,
  });
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("getFocusableElements", () => {
  it("returns enabled controls in DOM order, skipping disabled, hidden, and -1 tabindex", () => {
    const card = mountCard(`
      <button id="a">A</button>
      <button id="b" disabled>B</button>
      <input id="c" />
      <input id="d" type="hidden" />
      <a id="e">no href</a>
      <a id="f" href="#">link</a>
      <div id="g" tabindex="0">tabbable div</div>
      <div id="h" tabindex="-1">programmatic only</div>
      <button id="i" aria-hidden="true">aria-hidden</button>
      <span id="j" hidden><button id="k">inside hidden</button></span>
    `);

    expect(getFocusableElements(card).map((element) => element.id)).toEqual([
      "a",
      "c",
      "f",
      "g",
    ]);
  });

  it("returns an empty list when nothing is focusable", () => {
    const card = mountCard(`<p>read-only content</p>`);
    expect(getFocusableElements(card)).toEqual([]);
  });
});

describe("trapTabFocus", () => {
  it("wraps forward from the last control to the first", () => {
    const card = mountCard(`<button id="first">F</button><button id="last">L</button>`);
    card.querySelector<HTMLElement>("#last")!.focus();

    const event = tabEvent();
    trapTabFocus(card, event);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("first");
  });

  it("wraps backward from the first control to the last", () => {
    const card = mountCard(`<button id="first">F</button><button id="last">L</button>`);
    card.querySelector<HTMLElement>("#first")!.focus();

    const event = tabEvent(true);
    trapTabFocus(card, event);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("last");
  });

  it("enters the first control when Tab is pressed on the bare dialog surface", () => {
    const card = mountCard(`<button id="first">F</button><button id="last">L</button>`);
    card.focus();
    expect(document.activeElement).toBe(card);

    const event = tabEvent();
    trapTabFocus(card, event);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("first");
  });

  it("enters the last control on Shift+Tab from the bare dialog surface", () => {
    const card = mountCard(`<button id="first">F</button><button id="last">L</button>`);
    card.focus();

    const event = tabEvent(true);
    trapTabFocus(card, event);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("last");
  });

  it("leaves Tab between interior controls to the browser", () => {
    const card = mountCard(
      `<button id="first">F</button><input id="mid" /><button id="last">L</button>`,
    );
    card.querySelector<HTMLElement>("#mid")!.focus();

    const event = tabEvent();
    trapTabFocus(card, event);

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement?.id).toBe("mid");
  });

  it("pulls escaped focus back into the modal on the next Tab", () => {
    const card = mountCard(`<button id="first">F</button><button id="last">L</button>`);
    const outside = document.createElement("button");
    outside.id = "outside";
    document.body.append(outside);
    outside.focus();
    expect(document.activeElement?.id).toBe("outside");

    const event = tabEvent();
    trapTabFocus(card, event);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("first");
  });

  it("blocks Tab entirely when the modal has no focusable controls", () => {
    const card = mountCard(`<p>nothing to focus</p>`);

    const event = tabEvent();
    trapTabFocus(card, event);

    expect(event.defaultPrevented).toBe(true);
  });
});
