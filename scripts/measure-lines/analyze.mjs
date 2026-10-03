// Pure pixel sampling, colour math and report building for measure-lines.
// No Electron, no filesystem: the harness hands in captured bitmaps and the
// page's line geometry, and writes what these functions return.

// The colour at device pixel (x, y) of a BGRA bitmap (Chromium's native
// capture layout), as [r, g, b].
function pixel(bitmap, width, height, x, y) {
  const cx = Math.min(width - 1, Math.max(0, x));
  const cy = Math.min(height - 1, Math.max(0, y));
  const i = (cy * width + cx) * 4;
  return [bitmap[i + 2], bitmap[i + 1], bitmap[i]];
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function medianColor(colors) {
  return [0, 1, 2].map((c) => median(colors.map((color) => color[c])));
}

export function hex([r, g, b]) {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

function linear(channel) {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function luminance([r, g, b]) {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// CIE L* (D65) of an sRGB colour.
export function lightness(color) {
  const y = luminance(color);
  return y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (24389 / 27) * y;
}

const round = (value, places = 2) => Math.round(value * 10 ** places) / 10 ** places;

const distance = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

// Samples one measured line from the capture: the painted line at the centre of
// its band, and the pixel just clear of the band on each side, at every visible
// point along it; the median of each is what the line paints.
// "outer" is the side away from the element's box (left/top for a filled
// line), "inner" the side toward it (right/bottom for a filled line).
// An opaque line found up to two device pixels from where layout puts it (a
// collapsed table border straddles the cell edge) is sampled where it is.
// A line in the same colour as its own element's opaque fill is that fill's
// edge, so its backdrop is the outer side alone.
export function sampleLine(capture, line, dpr) {
  const { bitmap, width, height } = capture;
  const { axis, lo, hi, points } = line.geometry;
  let loD = lo * dpr;
  let hiD = hi * dpr;
  const at = (across, along) => (axis === "h"
    ? pixel(bitmap, width, height, Math.floor(along * dpr), across)
    : pixel(bitmap, width, height, across, Math.floor(along * dpr)));
  const rowColor = (row) => medianColor(points.map((p) => at(row, p)));

  const [r, g, b, a] = line.computedRgba;
  const centre = Math.floor((loD + hiD) / 2);
  if (a >= 1 && distance(rowColor(centre), [r, g, b]) > 8) {
    let best = centre;
    for (let row = centre - 2; row <= centre + 2; row += 1) {
      if (distance(rowColor(row), [r, g, b]) < distance(rowColor(best), [r, g, b])) best = row;
    }
    if (distance(rowColor(best), [r, g, b]) * 2 < distance(rowColor(centre), [r, g, b])) {
      loD += best - centre;
      hiD += best - centre;
    }
  }

  const center = Math.floor((loD + hiD) / 2);
  const paintedLine = rowColor(center);
  const low = rowColor(Math.floor(loD) - 1);
  const high = rowColor(Math.ceil(hiD));
  const outwardIsLow = line.side === "top" || line.side === "left" || line.side.startsWith("fill");
  const outer = outwardIsLow ? low : high;
  const inner = outwardIsLow ? high : low;
  const spread = Math.max(...[0, 1, 2].map((c) => {
    const values = points.map((p) => at(center, p)[c]);
    return Math.max(...values) - Math.min(...values);
  }));

  const fill = line.ownBackground;
  const edgeOfFill = line.kind !== "fill" && a >= 1 && fill !== null && fill[3] >= 1 && distance(fill, [r, g, b]) <= 3;
  const contrastOuter = contrastRatio(paintedLine, outer);
  const contrastInner = contrastRatio(paintedLine, inner);
  const lLine = lightness(paintedLine);
  const deltaOuter = lLine - lightness(outer);
  const deltaInner = lLine - lightness(inner);
  const innerWeaker = !edgeOfFill && contrastInner < contrastOuter;
  return {
    painted: { line: hex(paintedLine), outer: hex(outer), inner: hex(inner), sampleSpread: spread },
    edgeOfFill,
    contrast: { outer: round(contrastOuter), inner: round(contrastInner), backdrop: round(innerWeaker ? contrastInner : contrastOuter) },
    deltaL: { outer: round(deltaOuter, 1), inner: round(deltaInner, 1), backdrop: round(innerWeaker ? deltaInner : deltaOuter, 1) },
    backdrop: innerWeaker ? "inner" : "outer",
  };
}

function rgbaText([r, g, b, a]) {
  return a >= 1 ? hex([r, g, b]) : `${hex([r, g, b])} @ ${a}`;
}

export function groupKey(record) {
  if (record.token) return record.token.name;
  if (record.source) return record.source.replace(/^[\w-]+:\s*/, "");
  return rgbaText(record.computedRgba);
}

function range(values) {
  if (values.length === 0) return "–";
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return lo === hi ? `${lo}` : `${lo}–${hi}`;
}

function topCounts(values, limit) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const sorted = [...counts].sort((a, b) => b[1] - a[1]);
  const shown = sorted.slice(0, limit).map(([value, n]) => `${value} ×${n}`);
  return sorted.length > limit ? `${shown.join(", ")}, +${sorted.length - limit} more` : shown.join(", ");
}

const cell = (text) => String(text).replace(/\|/g, "\\|").replace(/\n/g, " ");

// lines.md: one row per colour group (token, authored expression, or computed
// colour), with where it is used and its painted contrast in each theme.
export function buildMarkdown({ records, surfaces, notes, appName }) {
  const measured = records.filter((r) => !r.focused);
  const groups = new Map();
  for (const record of measured) {
    const key = groupKey(record);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  const ordered = [...groups].sort((a, b) => b[1].length - a[1].length);

  const out = [];
  out.push(`# ${appName} lines`, "");
  out.push(`${records.length} lines measured across ${surfaces.length} surfaces in light and dark at device scale factor 2. Contrast is WCAG between the painted line and its backdrop, the painted pixel just beside it on the weaker side (the outer side alone for a line that is the edge of its element's own fill); ΔL* is the CIE lightness difference against the same pixel. Every value is read from the captured screenshots. Counts are per surface and theme, so one element seen on several surfaces counts on each.`, "");
  if (records.length !== measured.length) {
    out.push(`${records.length - measured.length} focus-state outlines are listed in lines.json and left out of the groups below.`, "");
  }
  out.push("## Groups", "");
  out.push("| Colour source | Lines | Used on (element ×lines) | Light contrast | Dark contrast | Light ΔL* | Dark ΔL* | Light backdrops | Dark backdrops |");
  out.push("|---|---|---|---|---|---|---|---|---|");
  for (const [key, items] of ordered) {
    const light = items.filter((r) => r.theme === "light");
    const dark = items.filter((r) => r.theme === "dark");
    const uses = topCounts(items.map((r) => (r.kind === "border" ? r.element.self : `${r.element.self} (${r.kind})`)), 5);
    const backdrops = (list) => topCounts(list.map((r) => r.painted[r.backdrop]), 4);
    out.push(`| ${cell(key)} | ${items.length} | ${cell(uses)} | ${range(light.map((r) => r.contrast.backdrop))} | ${range(dark.map((r) => r.contrast.backdrop))} | ${range(light.map((r) => Math.abs(r.deltaL.backdrop)))} | ${range(dark.map((r) => Math.abs(r.deltaL.backdrop)))} | ${backdrops(light)} | ${backdrops(dark)} |`);
  }
  out.push("", "## Surfaces", "");
  out.push("| Surface | Light lines | Dark lines | Captures |");
  out.push("|---|---|---|---|");
  for (const surface of surfaces) {
    const count = (theme) => records.filter((r) => r.surface === surface.name && r.theme === theme).length;
    out.push(`| ${surface.name} | ${count("light")} | ${count("dark")} | ${surface.pngs.join(", ")} |`);
  }
  if (notes.length > 0) {
    out.push("", "## Notes", "");
    for (const note of notes) out.push(`- ${note}`);
  }
  out.push("");
  return out.join("\n");
}
