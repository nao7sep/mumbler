import { afterEach, beforeEach } from "vitest";
import { CATALOGUES } from "@shared/i18n/catalogues";

// Every spec that renders the interface doubles as a check that no catalogue
// key reaches the screen untranslated: a key rendered as text or given to an
// attribute a person reads or hears. The TypeScript types cannot catch this,
// because a key is a string and React renders any string. The specs mount
// their own roots, so an observer watches the document while each one runs.

const KEYS = new Set(Object.keys(CATALOGUES.en));
const READ_ATTRIBUTES = ["title", "aria-label", "aria-description", "placeholder", "alt", "label"];
const KEY_LIKE = /[A-Za-z]\w*(?:\.\w+)+/g;

let observer: MutationObserver | null = null;
let found = new Set<string>();

function check(text: string | null) {
  for (const token of text?.match(KEY_LIKE) ?? []) {
    if (KEYS.has(token)) found.add(token);
  }
}

// Text nodes one by one: a container's textContent runs neighbours together.
function scan(node: Node) {
  if (node.nodeType === Node.TEXT_NODE) {
    check(node.nodeValue);
    return;
  }
  if (node instanceof Element) {
    for (const name of READ_ATTRIBUTES) check(node.getAttribute(name));
  }
  node.childNodes.forEach(scan);
}

function record(mutations: MutationRecord[]) {
  for (const mutation of mutations) {
    if (mutation.type === "childList") mutation.addedNodes.forEach(scan);
    else if (mutation.type === "characterData") check(mutation.target.nodeValue);
    else if (mutation.target instanceof Element) {
      check(mutation.target.getAttribute(mutation.attributeName ?? ""));
    }
  }
}

beforeEach(() => {
  if (typeof document === "undefined") return;
  found = new Set();
  scan(document.documentElement);
  observer = new MutationObserver(record);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: READ_ATTRIBUTES,
  });
});

afterEach(() => {
  if (!observer) return;
  record(observer.takeRecords());
  observer.disconnect();
  observer = null;
  if (found.size > 0) {
    throw new Error(`Untranslated catalogue keys on screen: ${[...found].join(", ")}`);
  }
});
