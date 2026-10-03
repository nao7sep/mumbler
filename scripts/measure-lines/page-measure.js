// Runs inside a renderer page (injected with webContents.executeJavaScript).
// Installs window.__measureLines, which finds every line the page paints —
// border sides, outlines, line-like box-shadows and thin filled elements — and
// returns its geometry, computed colour, authored source and the points where
// it is actually visible. It never changes what the page paints: the only DOM
// it adds is a display:none colour probe and a pointer-events override (which
// affects hit testing, not painting), both removed before it returns.
(() => {
  if (window.__measureLines) return;

  const SIDES = ["top", "right", "bottom", "left"];
  const SAMPLE_FRACTIONS = [0.2, 0.35, 0.5, 0.65, 0.8];
  const REPLACED = new Set(["IMG", "CANVAS", "VIDEO", "svg", "SVG", "IFRAME"]);

  function parseColor(value, probe) {
    const text = (value ?? "").trim();
    let m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(text);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), alpha(m[4])];
    m = /^color\(srgb\s+([-\d.e]+)\s+([-\d.e]+)\s+([-\d.e]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(text);
    if (m) return [Number(m[1]) * 255, Number(m[2]) * 255, Number(m[3]) * 255, alpha(m[4])];
    if (text === "transparent") return [0, 0, 0, 0];
    if (probe && text !== "" && CSS.supports("color", text)) {
      probe.style.color = "";
      probe.style.color = text;
      const resolved = getComputedStyle(probe).color;
      if (resolved !== text) return parseColor(resolved, null);
    }
    return null;
  }

  function alpha(raw) {
    if (raw === undefined) return 1;
    return raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : Number(raw);
  }

  function px(value) {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  }

  // Every style rule in the document, flattened, with media/supports conditions
  // evaluated now, in source order.
  function collectRules() {
    const rules = [];
    const walk = (list) => {
      for (const rule of list) {
        if (rule instanceof CSSStyleRule) {
          rules.push(rule);
          if (rule.cssRules?.length) walk(rule.cssRules);
        } else if (rule instanceof CSSMediaRule) {
          if (matchMedia(rule.conditionText).matches) walk(rule.cssRules);
        } else if (rule instanceof CSSSupportsRule) {
          if (CSS.supports(rule.conditionText)) walk(rule.cssRules);
        } else if (rule.cssRules) {
          walk(rule.cssRules);
        }
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        walk(sheet.cssRules);
      } catch {
        // A cross-origin sheet cannot be read; its rules simply do not appear.
      }
    }
    return rules;
  }

  function collectTokenNames(rules) {
    const names = new Set();
    for (const rule of rules) {
      for (let i = 0; i < rule.style.length; i += 1) {
        const name = rule.style[i];
        if (name.startsWith("--")) names.add(name);
      }
    }
    return [...names];
  }

  // Approximate selector specificity [ids, classes/attrs/pseudo-classes, types].
  function specificity(selector) {
    const s = selector.replace(/::?[\w-]+\(/g, (m) => (m.startsWith("::") ? " " : "(")).replace(/\([^)]*\)/g, "");
    const ids = (s.match(/#[\w-]+/g) ?? []).length;
    const classes = (s.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) ?? []).length;
    const types = (s.replace(/#[\w-]+|\.[\w-]+|\[[^\]]*\]|:+[\w-]+/g, " ").match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []).length;
    return ids * 1e6 + classes * 1e3 + types;
  }

  function splitSelectors(selectorText) {
    const parts = [];
    let depth = 0;
    let current = "";
    for (const ch of selectorText) {
      if (ch === "(") depth += 1;
      if (ch === ")") depth -= 1;
      if (ch === "," && depth === 0) {
        parts.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
  }

  // The declaration that wins for one of `props` on `el`, as authored text,
  // e.g. "border-bottom: 1px solid var(--border-subtle)".
  function authoredSource(el, rules, props) {
    let best = null;
    rules.forEach((rule, order) => {
      const declared = props.find((p) => rule.style.getPropertyValue(p) !== "");
      if (!declared) return;
      let spec = -1;
      for (const part of splitSelectors(rule.selectorText)) {
        try {
          if (el.matches(part)) spec = Math.max(spec, specificity(part));
        } catch {
          // A selector this engine cannot match (e.g. a vendor pseudo) never applies.
        }
      }
      if (spec < 0) return;
      const important = rule.style.getPropertyPriority(declared) === "important" ? 1 : 0;
      const rank = [important, spec, order];
      if (!best || compareRank(rank, best.rank) > 0) {
        best = { rank, text: `${declared}: ${rule.style.getPropertyValue(declared).trim()}`, selector: rule.selectorText };
      }
    });
    const inlineProp = props.find((p) => el.style?.getPropertyValue(p));
    if (inlineProp) return { text: `${inlineProp}: ${el.style.getPropertyValue(inlineProp)}`, selector: "[style]" };
    return best ? { text: best.text, selector: best.selector } : null;
  }

  function compareRank(a, b) {
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  }

  function classPath(el) {
    const label = (node) => {
      const cls = (node.getAttribute("class") ?? "").trim().split(/\s+/).filter(Boolean);
      return node.tagName.toLowerCase() + (node.id ? `#${node.id}` : "") + cls.map((c) => `.${c}`).join("");
    };
    const parts = [label(el)];
    let node = el.parentElement;
    while (node && parts.length < 3 && node !== document.body) {
      if (node.getAttribute("class")) parts.unshift(label(node));
      node = node.parentElement;
    }
    return { self: label(el), path: parts.join(" > ") };
  }

  function nearbyText(el) {
    const clean = (t) => (t ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    const own = clean(el.getAttribute("aria-label")) || clean(el.innerText) || clean(el.getAttribute("placeholder")) || clean(el.value);
    if (own) return own;
    let node = el.parentElement;
    while (node && node !== document.body) {
      const t = clean(node.getAttribute("aria-label")) || clean(node.innerText);
      if (t) return `(in) ${t}`;
      node = node.parentElement;
    }
    return "";
  }

  function paints(node) {
    if (REPLACED.has(node.tagName)) return true;
    const cs = getComputedStyle(node);
    if (cs.backgroundImage !== "none") return true;
    const bg = parseColor(cs.backgroundColor, null);
    return bg !== null && bg[3] > 0;
  }

  // A line drawn inside el's border box is visible at (x, y) when el is hit
  // there and nothing hit above it paints; a line drawn outside the box is
  // visible when the first painting element there is one of el's ancestors.
  function visibleAt(el, x, y, inside) {
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
    const stack = document.elementsFromPoint(x, y);
    if (inside) {
      const idx = stack.indexOf(el);
      if (idx < 0) return false;
      for (let i = 0; i < idx; i += 1) if (paints(stack[i])) return false;
      return true;
    }
    const firstPainter = stack.find((node) => node !== el && !el.contains(node) && paints(node));
    if (!firstPainter) return true;
    return firstPainter.contains(el);
  }

  // Geometry for one straight line: `axis` is "h" for a horizontal line (top or
  // bottom), "v" for a vertical one; [lo, hi) is its extent across the line and
  // [from, to] its usable length along it, corners trimmed.
  function lineSpec(rect, side, lo, hi, trim) {
    const horizontal = side === "top" || side === "bottom" || side === "fill-h";
    const from = (horizontal ? rect.left : rect.top) + trim;
    const to = (horizontal ? rect.right : rect.bottom) - trim;
    return { axis: horizontal ? "h" : "v", lo, hi, from, to };
  }

  function band(rect, side, outerOffset, width) {
    // outerOffset: distance of the line's outer edge from the border box edge,
    // positive outward. Returns [lo, hi) across the line in viewport px.
    switch (side) {
      case "top": return [rect.top - outerOffset, rect.top - outerOffset + width];
      case "bottom": return [rect.bottom + outerOffset - width, rect.bottom + outerOffset];
      case "left": return [rect.left - outerOffset, rect.left - outerOffset + width];
      case "right": return [rect.right + outerOffset - width, rect.right + outerOffset];
      default: return null;
    }
  }

  function parseShadows(value) {
    if (!value || value === "none") return [];
    const parts = splitSelectors(value);
    return parts.map((part) => {
      const colorMatch = /(rgba?\([^)]*\)|color\([^)]*\)|#[0-9a-f]{3,8}\b)/i.exec(part);
      const rest = colorMatch ? part.replace(colorMatch[0], " ") : part;
      const nums = (rest.match(/-?[\d.]+px/g) ?? []).map(px);
      return {
        color: colorMatch ? colorMatch[0] : "currentcolor",
        inset: /\binset\b/.test(rest),
        x: nums[0] ?? 0,
        y: nums[1] ?? 0,
        blur: nums[2] ?? 0,
        spread: nums[3] ?? 0,
        raw: part.trim(),
      };
    });
  }

  window.__measureLines = function measureLines(options = {}) {
    // Lines already reported in this pass (element -> "kind:side"), so paging
    // through a scroll container reports each line once.
    if (options.reset || !window.__measuredLines) window.__measuredLines = new WeakMap();
    const measured = window.__measuredLines;
    const dpr = window.devicePixelRatio;
    const probe = document.createElement("div");
    probe.style.display = "none";
    document.documentElement.appendChild(probe);
    const hitStyle = document.createElement("style");
    hitStyle.textContent = "*, *::before, *::after { pointer-events: auto !important; }";
    document.documentElement.appendChild(hitStyle);

    try {
      const rules = collectRules();
      const tokenNames = collectTokenNames(rules);
      const colorCache = new Map();
      const normalize = (raw) => {
        const key = raw.trim();
        if (!colorCache.has(key)) colorCache.set(key, parseColor(key, probe));
        return colorCache.get(key);
      };
      const sameColor = (a, b) => a && b && Math.abs(a[3] - b[3]) < 0.01 && [0, 1, 2].every((i) => Math.abs(a[i] - b[i]) < 0.75);

      // Which custom property the colour comes from: one the authored source
      // names first, else any token resolving to the same colour on this element.
      const tokenFor = (el, color, source) => {
        const cs = getComputedStyle(el);
        const referenced = source ? [...source.text.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]) : [];
        for (const name of referenced) {
          if (sameColor(normalize(cs.getPropertyValue(name)), color)) return { name, by: "source" };
        }
        if (source && /color-mix|rgba?\(|#[0-9a-f]{3,8}\b|hsl|oklch/i.test(source.text.replace(/var\([^)]*\)/g, ""))) {
          return null;
        }
        for (const name of tokenNames) {
          const raw = cs.getPropertyValue(name);
          if (raw && sameColor(normalize(raw), color)) return { name, by: "value" };
        }
        return null;
      };

      const lines = [];
      const hiddenOwners = new Set();

      const addLine = (el, info) => {
        const { kind, side, width, colorRaw, insideBox, spec, sourceProps, extra } = info;
        const color = normalize(colorRaw);
        if (!color || color[3] <= 0 || width <= 0) return;
        const key = `${kind}:${side}`;
        if (measured.get(el)?.has(key)) return;
        const length = spec.to - spec.from;
        if (length < 1) return;
        const points = [];
        for (const f of SAMPLE_FRACTIONS) {
          const along = spec.from + f * length;
          const across = (spec.lo + spec.hi) / 2;
          const x = spec.axis === "h" ? along : across;
          const y = spec.axis === "h" ? across : along;
          if (visibleAt(el, x, y, insideBox)) points.push(along);
        }
        if (points.length === 0) {
          hiddenOwners.add(el);
          return;
        }
        const source = authoredSource(el, rules, sourceProps);
        const names = classPath(el);
        lines.push({
          kind,
          side,
          widthCss: Math.round(width * 100) / 100,
          computedColor: colorRaw.trim(),
          computedRgba: color.map((v, i) => (i < 3 ? Math.round(v) : Math.round(v * 1000) / 1000)),
          token: tokenFor(el, color, source),
          source: source?.text ?? null,
          sourceSelector: source?.selector ?? null,
          element: { self: names.self, path: names.path, text: nearbyText(el) },
          ownBackground: parseColor(getComputedStyle(el).backgroundColor, probe),
          focused: el.matches(":focus") || el.matches(":focus-visible"),
          geometry: { axis: spec.axis, lo: spec.lo, hi: spec.hi, points },
          ...extra,
        });
        if (!measured.has(el)) measured.set(el, new Set());
        measured.get(el).add(key);
      };

      for (const el of document.querySelectorAll("body *")) {
        if (el === probe || el === hitStyle) continue;
        const rects = el.getClientRects();
        if (rects.length === 0) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden") continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) continue;
        const radius = Math.max(
          px(cs.borderTopLeftRadius), px(cs.borderTopRightRadius),
          px(cs.borderBottomLeftRadius), px(cs.borderBottomRightRadius),
        );
        const bw = Object.fromEntries(SIDES.map((s) => [s, cs[`border${cap(s)}Style`] === "none" || cs[`border${cap(s)}Style`] === "hidden" ? 0 : px(cs[`border${cap(s)}Width`])]));

        // Border sides.
        for (const side of SIDES) {
          if (bw[side] <= 0) continue;
          const adjacent = side === "top" || side === "bottom" ? Math.max(bw.left, bw.right) : Math.max(bw.top, bw.bottom);
          const [lo, hi] = band(rect, side, 0, bw[side]);
          addLine(el, {
            kind: "border", side, width: bw[side], colorRaw: cs[`border${cap(side)}Color`], insideBox: true,
            spec: lineSpec(rect, side, lo, hi, radius + adjacent + 2),
            sourceProps: [`border-${side}-color`, `border-${side}`, "border-color", "border"],
          });
        }

        // Outline.
        if (cs.outlineStyle !== "none" && px(cs.outlineWidth) > 0) {
          const ow = px(cs.outlineWidth);
          const off = px(cs.outlineOffset);
          for (const side of SIDES) {
            const [lo, hi] = band(rect, side, off + ow, ow);
            addLine(el, {
              kind: "outline", side, width: ow, colorRaw: cs.outlineColor, insideBox: off + ow <= 0,
              spec: lineSpec(rect, side, lo, hi, radius + ow + 2),
              sourceProps: ["outline-color", "outline"],
            });
          }
        }

        // Box-shadows that draw a crisp line: no blur, and either a spread ring
        // with no offset, or a single-axis offset with no spread.
        for (const shadow of parseShadows(cs.boxShadow)) {
          if (shadow.blur !== 0) continue;
          const ring = shadow.x === 0 && shadow.y === 0 && shadow.spread > 0;
          const offsetLine = shadow.spread === 0 && (shadow.x === 0) !== (shadow.y === 0);
          if (!ring && !offsetLine) continue;
          const sides = ring
            ? SIDES.map((side) => [side, shadow.spread])
            : shadow.y !== 0
              ? [[(shadow.y > 0) === shadow.inset ? "top" : "bottom", Math.abs(shadow.y)]]
              : [[(shadow.x > 0) === shadow.inset ? "left" : "right", Math.abs(shadow.x)]];
          for (const [side, width] of sides) {
            const offset = shadow.inset ? -bw[side] : width;
            const [lo, hi] = band(rect, side, offset, width);
            addLine(el, {
              kind: "box-shadow", side, width, colorRaw: shadow.color, insideBox: shadow.inset,
              spec: lineSpec(rect, side, lo, hi, radius + width + 2),
              sourceProps: ["box-shadow"],
              extra: { shadow: shadow.raw },
            });
          }
        }

        // A thin filled element used as a divider, grip or rule.
        const thin = Math.min(rect.width, rect.height);
        const long = Math.max(rect.width, rect.height);
        if (thin <= 3 && long >= 8 && el.children.length === 0) {
          const bg = cs.backgroundColor;
          const horizontal = rect.width >= rect.height;
          const lo = horizontal ? rect.top : rect.left;
          const hi = horizontal ? rect.bottom : rect.right;
          addLine(el, {
            kind: "fill", side: horizontal ? "fill-h" : "fill-v", width: thin, colorRaw: bg, insideBox: true,
            spec: lineSpec(rect, horizontal ? "fill-h" : "fill-v", lo, hi, Math.min(radius + 1, long / 4)),
            sourceProps: ["background-color", "background"],
          });
        }
      }

      // Scroll containers in the top layer that hide a line further down, so
      // the caller can page through them and measure it.
      // Only containers in the top layer: paging what a dialog covers would
      // reveal nothing measurable.
      const coveredByOverlay = () => {
        const stack = document.elementsFromPoint(innerWidth / 2, innerHeight / 2);
        return stack.some((node) => {
          const r = node.getBoundingClientRect();
          return getComputedStyle(node).position === "fixed" && r.width >= innerWidth * 0.9 && r.height >= innerHeight * 0.9 && paints(node);
        });
      };
      const inTopLayer = (node) => {
        if (node === document.scrollingElement) return !coveredByOverlay();
        const r = node.getBoundingClientRect();
        const stack = document.elementsFromPoint(r.left + r.width / 2, r.top + Math.min(r.height, innerHeight - r.top) / 2);
        const idx = stack.indexOf(node);
        return idx >= 0 && stack.slice(0, idx).every((above) => node.contains(above) || !paints(above));
      };
      const scrollables = [];
      const candidates = [document.scrollingElement, ...document.querySelectorAll("body *")];
      for (const node of candidates) {
        if (!node || node.tagName === "TEXTAREA" || node.tagName === "PRE") continue;
        const cs = getComputedStyle(node);
        const scrollsY = node === document.scrollingElement || /(auto|scroll)/.test(cs.overflowY);
        if (!scrollsY || node.scrollHeight - node.clientHeight < 4) continue;
        if (node.scrollTop + node.clientHeight >= node.scrollHeight - 1) continue;
        if (node !== document.scrollingElement && node.getClientRects().length === 0) continue;
        if (!inTopLayer(node)) continue;
        const bottom = node === document.scrollingElement ? innerHeight : node.getBoundingClientRect().top + node.clientHeight;
        const hidesLine = [...hiddenOwners].some((el) => node.contains(el) && el.getBoundingClientRect().bottom > bottom);
        if (hidesLine) scrollables.push(node);
      }
      window.__scrollTargets = scrollables;

      return {
        dpr,
        viewport: { width: innerWidth, height: innerHeight },
        lines,
        scrollables: scrollables.map((node, index) => ({ index, label: classPath(node).self })),
      };
    } finally {
      probe.remove();
      hitStyle.remove();
    }
  };

  // Scrolls one container from the last measurement by most of a page; returns
  // whether it moved.
  window.__scrollStep = function scrollStep(index) {
    const node = window.__scrollTargets?.[index];
    if (!node) return false;
    const before = node.scrollTop;
    node.scrollTop = before + Math.max(40, node.clientHeight * 0.85);
    (window.__scrolledNodes ??= new Set()).add(node);
    return node.scrollTop !== before;
  };

  window.__resetScroll = function resetScroll() {
    for (const node of window.__scrolledNodes ?? []) node.scrollTop = 0;
    window.__scrolledNodes = new Set();
    window.__scrollTargets = [];
  };

  function cap(s) {
    return s[0].toUpperCase() + s.slice(1);
  }
})();
