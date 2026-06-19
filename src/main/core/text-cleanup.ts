// Per-app realization of the fleet text-cleanup conventions
// (company/conventions/20260619-004022-utc-text-cleanup-conventions.md).
//
// There is no shared package: each app copies the canonical algorithm into its
// own small helper and tests it locally. Mumbler stores AI-generated bodies
// (transcripts, structured outlines) and user-edited LLM prompt templates, all of
// which are multi-line. Cleanup runs at commit time — when a pipeline result is
// stored or a settings draft is applied — never while the user is editing.
//
// Only the `multiline` pattern is needed here; the previews mumbler renders are of
// audio, not text, so multiline-truncation has no use, and the single-line need is
// already met by the domain-specific `sanitizeTitle`/`sanitizeSlug` in
// card-pipeline.ts (which do Markdown/quote stripping and slugify+validation that
// reach well past the whitespace half this helper covers).

/**
 * Clean a multi-line body where line structure carries meaning.
 *
 * Splits on `\r\n | \r | \n` and rejoins with `\n`, normalizing newlines as a side
 * effect. Indentation is always preserved — de-indenting is a separate transform.
 *
 * - `trimLineEnds` (default true): drop each line's trailing whitespace. Switch off
 *   only for Markdown bodies that rely on two trailing spaces as a hard line break.
 * - `dropEdgeBlankLines` (default true): drop blank lines before the first and after
 *   the last visible line.
 * - `collapseBlankLines` (default false): reduce interior runs of blank lines to one.
 *   Off by default because an interior blank run is often a deliberate section break.
 *
 * A line is "blank" when its trimmed form is empty, so a whitespace-only line (spaces,
 * tabs, or a lone full-width U+3000) counts as blank. This is the right final step for
 * a multi-line body: a scalar `.trim()` would treat a leading newline plus the next
 * line's indentation as one run and eat that indentation, and would leave interior
 * trailing whitespace untouched.
 */
export function multiline(
  text: string,
  opts: { trimLineEnds?: boolean; dropEdgeBlankLines?: boolean; collapseBlankLines?: boolean } = {},
): string {
  const { trimLineEnds = true, dropEdgeBlankLines = true, collapseBlankLines = false } = opts;
  const isBlank = (l: string): boolean => l.trim() === "";
  let lines = text.split(/\r\n|\r|\n/);
  if (trimLineEnds) lines = lines.map((l) => l.replace(/\s+$/, ""));

  let start = 0;
  let end = lines.length;
  if (dropEdgeBlankLines) {
    while (start < end && isBlank(lines[start])) start++;
    while (end > start && isBlank(lines[end - 1])) end--;
  }

  const out: string[] = [];
  let prevBlank = false;
  for (const line of lines.slice(start, end)) {
    const blank = isBlank(line);
    if (collapseBlankLines && blank && prevBlank) continue;
    out.push(line);
    prevBlank = blank;
  }
  return out.join("\n");
}
