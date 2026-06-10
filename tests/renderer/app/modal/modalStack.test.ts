// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { isTopmostModal, registerModal, unregisterModal } from "@renderer/app/modal/modalStack";

// modalStack keeps module-global state. Record every modal a test opens and
// drain whatever is left in afterEach, so a failed assertion before a test's own
// unregister calls cannot leak a stale entry into the next test.
const opened: symbol[] = [];

function openModal(): symbol {
  const id = registerModal();
  opened.push(id);
  return id;
}

afterEach(() => {
  while (opened.length > 0) {
    unregisterModal(opened.pop()!);
  }
  document.body.style.overflow = "";
});

describe("modal stack ordering", () => {
  it("treats the most recently registered modal as the topmost", () => {
    const first = openModal();
    expect(isTopmostModal(first)).toBe(true);

    const second = openModal();
    expect(isTopmostModal(first)).toBe(false);
    expect(isTopmostModal(second)).toBe(true);

    // Unwinding one level restores the modal underneath as topmost.
    unregisterModal(second);
    expect(isTopmostModal(first)).toBe(true);

    unregisterModal(first);
    expect(isTopmostModal(first)).toBe(false);
  });

  it("tolerates out-of-order unregistration without leaving a false topmost", () => {
    const first = openModal();
    const second = openModal();

    unregisterModal(first);
    expect(isTopmostModal(second)).toBe(true);
    expect(isTopmostModal(first)).toBe(false);

    unregisterModal(second);
    expect(isTopmostModal(second)).toBe(false);
  });
});

describe("background scroll lock", () => {
  it("locks on the first modal and restores the prior value only when the last closes", () => {
    document.body.style.overflow = "scroll";

    const first = openModal();
    expect(document.body.style.overflow).toBe("hidden");

    // A stacked modal must not re-lock or unlock; the page stays locked.
    const second = openModal();
    expect(document.body.style.overflow).toBe("hidden");

    unregisterModal(second);
    expect(document.body.style.overflow).toBe("hidden");

    unregisterModal(first);
    expect(document.body.style.overflow).toBe("scroll");
  });
});
