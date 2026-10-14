// @vitest-environment node
//
// A shortened value shows exactly one marker and keeps a keyboard and touch path
// to its whole text (interface-styling-conventions, Labels; responsive-
// interface-conventions). Each place styles.css shortens text is listed here with that
// path, and a clip without a marker fails: a rule that holds text to one line
// and hides the overflow must draw an ellipsis.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { WINDOW_MIN_WIDTH } from "@shared/layout";

const STYLESHEET = readFileSync(join(__dirname, "..", "..", "src/renderer/src/styles.css"), "utf8");

// Reviewed sites, each with the path to the whole value.
const ELLIPSIS_SITES: Record<string, string> = {
  select: "opening the select lists every option in full",
  ".app-menu-item": "the menu's width cap fits every command in every language, and the window's minimum width fits the cap",
  ".queue-row__filename": "selecting the row shows the whole name in the Info tab",
  ".records-row__title": "selecting the row shows its operation in the detail pane",
  ".queue-row__error": "selecting the row shows the whole error and the provider's reason in the detail pane",
  ".shortened__text, .shortened__head, .shortened__tail": "a cut value is a control: click, tap, Enter or Space shows it whole",
};
const LINE_CLAMP_SITES: Record<string, string> = {
  ".records-row__text": "selecting the row shows the whole message in the detail pane",
};
// One-line, overflow-hidden rules that hold no visible text.
const NOT_TEXT: Record<string, string> = {
  ".visually-hidden": "off-screen text read by assistive technology",
};

type Rule = { selector: string; body: string };

function rules(css: string): Rule[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: match[1]!.trim().replace(/\s+/g, " "),
    body: match[2]!,
  }));
}

const all = rules(STYLESHEET);

describe("truncation markers", () => {
  it("keeps the menu's width cap inside the window's minimum width", () => {
    const menu = all.find((rule) => rule.selector === ".app-menu")!;
    const cap = /max-width\s*:\s*min\((\d+)px/.exec(menu.body);
    expect(cap, "the menu's width is capped").not.toBeNull();
    expect(Number(cap![1])).toBeLessThan(WINDOW_MIN_WIDTH - 16);
  });

  it("draws an ellipsis only at reviewed sites", () => {
    const sites = all.filter((rule) => /text-overflow\s*:\s*ellipsis/.test(rule.body)).map((rule) => rule.selector);
    expect(sites.sort()).toEqual(Object.keys(ELLIPSIS_SITES).sort());
  });

  it("clamps lines only at reviewed sites", () => {
    const sites = all.filter((rule) => /line-clamp\s*:/.test(rule.body)).map((rule) => rule.selector);
    expect(sites.sort()).toEqual(Object.keys(LINE_CLAMP_SITES).sort());
  });

  it("never clips one-line text without a marker", () => {
    const silent = all
      .filter((rule) => /white-space\s*:\s*nowrap/.test(rule.body))
      .filter((rule) => /overflow(-x)?\s*:\s*(hidden|clip)/.test(rule.body))
      .filter((rule) => !/text-overflow\s*:\s*ellipsis/.test(rule.body))
      .map((rule) => rule.selector)
      .filter((selector) => !(selector in NOT_TEXT));
    expect(silent).toEqual([]);
  });
});
