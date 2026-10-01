import { useEffect, useRef, useState, type RefObject } from "react";

import { clampSplitter } from "@shared/layout";

/**
 * Derive an adjustable pane's DISPLAYED size from its persisted INTENT and the
 * live container.
 *
 * Pane sizing: window-conventions.
 *
 * Returns a ref to attach to the container whose extent feeds the clamp (here the
 * `.workspace` grid) and the derived displayed size. Before the container has
 * measured (first paint) it falls back to the pane min/max clamp of the intent, so
 * the pane never renders wider than its own bounds even for a frame.
 */
export function usePaneSize<E extends HTMLElement = HTMLDivElement>(
  intent: number,
  vertical: boolean,
  opts: { siblingMin: number; min: number; max: number },
): { containerRef: RefObject<E | null>; displayed: number } {
  const containerRef = useRef<E | null>(null);
  const [available, setAvailable] = useState<number | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = (): void => setAvailable(vertical ? el.clientHeight : el.clientWidth);
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, [vertical]);

  const { siblingMin, min, max } = opts;
  const displayed =
    available !== null
      ? clampSplitter(intent, { available, siblingMin, min, max })
      : Math.max(min, Math.min(max, intent));

  return { containerRef, displayed };
}
