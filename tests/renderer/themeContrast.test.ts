import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// Every color pair the stylesheet draws keeps high contrast in both themes,
// by this app's own floor: 4.5:1 for text, 3:1 for a text field's
// outline. Light tokens live in the top-level :root block; dark tokens in the
// :root block inside @media (prefers-color-scheme: dark).
const css = readFileSync(resolve("src/renderer/src/styles.css"), "utf8");

type Rgb = [number, number, number];

function themeBlock(theme: "light" | "dark"): string {
  if (theme === "light") {
    const start = css.search(/^:root\s*\{/m);
    return css.slice(css.indexOf("{", start), css.indexOf("\n}", start));
  }
  const media = css.indexOf("@media (prefers-color-scheme: dark) {");
  expect(media, "the dark theme must be a prefers-color-scheme block").toBeGreaterThanOrEqual(0);
  const start = css.indexOf("  :root {", media);
  return css.slice(css.indexOf("{", start), css.indexOf("\n  }", start));
}

function rawOf(block: string, token: string): string {
  const value = block.match(new RegExp(`${token.replaceAll("-", "\\-")}\\s*:\\s*(#[0-9a-f]{6})\\s*;`, "i"))?.[1];
  expect(value, `${token} must be an opaque six-digit hex color`).toBeTruthy();
  return value!;
}

function hexOf(block: string, token: string): Rgb {
  const value = block.match(new RegExp(`${token.replaceAll("-", "\\-")}\\s*:\\s*(#[0-9a-f]{6})\\s*;`, "i"))?.[1];
  expect(value, `${token} must be an opaque six-digit hex color`).toBeTruthy();
  return [1, 3, 5].map((offset) => Number.parseInt(value!.slice(offset, offset + 2), 16)) as Rgb;
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(first: Rgb, second: Rgb): number {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const SURFACES = ["--bg", "--surface", "--surface-raised", "--surface-muted", "--surface-hover", "--surface-active", "--field-bg"];
const INKS = ["--text", "--text-secondary", "--text-tertiary", "--accent", "--danger", "--success", "--warning", "--processing", "--link"];

const TEXT_PAIRS: ReadonlyArray<[string, string]> = [
  ...INKS.flatMap((ink): Array<[string, string]> => SURFACES.map((surface) => [ink, surface])),
  ["--on-accent", "--accent"],
  ["--on-accent", "--accent-hover"],
  // The confirming button of a destructive dialog is filled, so its ink is read
  // on the fill, not on a surface — in both its resting and hovered colour.
  ["--on-danger", "--danger-fill"],
  ["--on-danger", "--danger-fill-hover"],
  ["--on-danger", "--danger-fill-pressed"],
  ["--text", "--accent-subtle"],
  ["--accent", "--accent-subtle"],
  ["--danger", "--danger-subtle"],
  ["--success", "--success-subtle"],
  ["--warning", "--warning-subtle"],
  ["--processing", "--processing-subtle"],
  ["--topbar-text", "--topbar"],
  ["--topbar-muted", "--topbar"],
];

const BOUNDARY_PAIRS: ReadonlyArray<[string, string]> = [
  ["--field-border", "--field-bg"],
  ["--field-border", "--surface-raised"],
  ["--field-border", "--surface"],
  ["--field-border", "--bg"],
];

describe("theme token contrast", () => {
  for (const theme of ["light", "dark"] as const) {
    it(`keeps text at 4.5:1 or more in the ${theme} theme`, () => {
      const block = themeBlock(theme);
      for (const [foreground, background] of TEXT_PAIRS) {
        expect(contrast(hexOf(block, foreground), hexOf(block, background)), `${foreground} on ${background}`)
          .toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`keeps text-field outlines at 3:1 or more in the ${theme} theme`, () => {
      const block = themeBlock(theme);
      for (const [foreground, background] of BOUNDARY_PAIRS) {
        expect(contrast(hexOf(block, foreground), hexOf(block, background)), `${foreground} on ${background}`)
          .toBeGreaterThanOrEqual(3);
      }
    });
  }

  it("keeps the top bar's tools status capsule legible in both themes", () => {
    // The capsule is its role hue at 16% over the top bar's gradient, so check
    // its text against that blend at both ends of the gradient.
    const blend = (base: Rgb, hue: Rgb, amount: number): Rgb =>
      base.map((channel, index) => Math.round(channel * (1 - amount) + hue[index]! * amount)) as Rgb;
    for (const theme of ["light", "dark"] as const) {
      const block = themeBlock(theme);
      for (const [hue, text] of [["--topbar-warning", "--topbar-warning-text"], ["--topbar-danger", "--topbar-danger-text"]]) {
        for (const bar of ["--topbar", "--topbar-end"]) {
          const background = blend(hexOf(block, bar), hexOf(block, hue!), 0.16);
          expect(contrast(hexOf(block, text!), background), `${text} on ${hue} over ${bar} in ${theme}`)
            .toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("keeps a card's status edge visible against the card in both themes", () => {
    // A status card carries its state as its own edge: the status hue at 70%
    // over --border, which must still read as an edge on the card's surface.
    const blend = (base: Rgb, hue: Rgb, amount: number): Rgb =>
      base.map((channel, index) => Math.round(channel * (1 - amount) + hue[index]! * amount)) as Rgb;
    for (const theme of ["light", "dark"] as const) {
      const block = themeBlock(theme);
      for (const status of ["--processing", "--success", "--danger"]) {
        const edge = blend(hexOf(block, "--border"), hexOf(block, status), 0.7);
        expect(contrast(edge, hexOf(block, "--surface-raised")), `${status} edge in ${theme}`)
          .toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("draws each theme's select chevron in that theme's secondary ink", () => {
    // The chevron is an image URL, which cannot read a custom property, so its
    // stroke repeats --text-secondary and has to be checked against it.
    for (const theme of ["light", "dark"] as const) {
      const block = themeBlock(theme);
      const stroke = /stroke='%23([0-9a-fA-F]{6})'/.exec(block);
      expect(stroke, `a drawn chevron in ${theme}`).not.toBeNull();
      expect(`#${stroke![1]!.toLowerCase()}`, `the ${theme} chevron follows --text-secondary`)
        .toBe(rawOf(block, "--text-secondary").toLowerCase());
    }
  });

  it("defines every waveform color in both themes", () => {
    for (const theme of ["light", "dark"] as const) {
      const block = themeBlock(theme);
      for (const token of ["--waveform-wave", "--waveform-progress", "--waveform-cursor", "--waveform-region"]) {
        expect(block, `${token} in ${theme}`).toMatch(new RegExp(`${token}\\s*:`));
      }
    }
  });
});
