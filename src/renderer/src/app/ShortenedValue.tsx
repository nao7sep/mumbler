import type { ReactElement } from "react";

// A name or path that identifies an item, shown on one line in the space its
// container gives it (interface-styling-conventions, Identifying text). A name
// keeps its beginning; a path keeps its final segment and loses its middle,
// because its beginning is usually shared. The element's text is always the
// whole value, so an accessible name and a copied selection carry it complete,
// and the tooltip shows it to a pointer.

/** Splits a path after its last separator: the folders, then the final segment. */
export function splitPath(value: string): { head: string; tail: string } {
  const cut = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  // A trailing separator names the folder before it as the final segment.
  if (cut === value.length - 1 && cut > 0) {
    const inner = Math.max(value.lastIndexOf("/", cut - 1), value.lastIndexOf("\\", cut - 1));
    return { head: value.slice(0, inner + 1), tail: value.slice(inner + 1) };
  }
  return { head: value.slice(0, cut + 1), tail: value.slice(cut + 1) };
}

export function ShortenedValue({ kind, value }: { kind: "name" | "path"; value: string }): ReactElement {
  const { head, tail } = kind === "path" ? splitPath(value) : { head: "", tail: value };
  return (
    <span className="shortened" title={value}>
      {head === "" ? (
        <span className="shortened__text">{value}</span>
      ) : (
        <>
          <span className="shortened__head">{head}</span>
          <span className="shortened__tail">{tail}</span>
        </>
      )}
    </span>
  );
}
