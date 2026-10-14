import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactElement } from "react";

// A name or path that identifies an item, shown on one line in the space its
// container gives it (interface-styling-conventions, Labels). A name keeps its
// beginning; a path keeps its final segment and loses its middle, because its
// beginning is usually shared. Only a value that is actually cut becomes a
// control: clicking, tapping, Enter or Space shows it whole, wrapped, and
// again shortens it. The whole value is always the element's text, so an
// accessible name and a copy of the selection carry it complete.

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

export function ShortenedValue({
  kind,
  value,
  className,
}: {
  kind: "name" | "path";
  value: string;
  className?: string;
}): ReactElement {
  const ref = useRef<HTMLSpanElement>(null);
  const [whole, setWhole] = useState(false);
  const [cut, setCut] = useState(false);

  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null || whole) return;
    const measure = (): void => {
      setCut([...element.querySelectorAll<HTMLElement>("[data-fit]")].some((part) => part.scrollWidth > part.clientWidth));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [value, whole, kind]);

  const toggle = (): void => setWhole((current) => !current);
  const interactive = cut || whole;
  const { head, tail } = kind === "path" ? splitPath(value) : { head: "", tail: value };

  return (
    <span
      ref={ref}
      className={`shortened${whole ? " shortened--whole" : ""}${className ? ` ${className}` : ""}`}
      {...(interactive
        ? {
          role: "button",
          tabIndex: 0,
          "aria-expanded": whole,
          // Inside a toast, which a click dismisses, revealing the value is not a dismissal.
          onClick: (event: { stopPropagation: () => void }) => {
            event.stopPropagation();
            toggle();
          },
          onKeyDown: (event: KeyboardEvent<HTMLSpanElement>) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            toggle();
          },
        }
        : {})}
    >
      {whole || head === "" ? (
        <span data-fit className="shortened__text">{value}</span>
      ) : (
        <>
          <span data-fit className="shortened__head">{head}</span>
          <span data-fit className="shortened__tail">{tail}</span>
        </>
      )}
    </span>
  );
}
