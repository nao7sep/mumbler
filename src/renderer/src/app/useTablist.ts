import { useCallback, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { indexOfId, nextIndex } from "./composite-nav";

// The app's tablist layer: one shared hook behind every tab bar (currently the
// detail pane's wizard tabs). It realizes the composite-control contract for
// tablists:
//
//   - One tab stop (roving tabindex): the active tab carries tabIndex 0, every
//     other tab tabIndex -1, so Tab enters the strip on the active tab and Tab
//     again leaves it.
//   - Left/Right + Home/End move the active tab; stop-at-ends, no wrap.
//   - Activation follows focus: moving to a tab selects it immediately, because
//     the panel swap is a cheap local render. Active == selected for a tablist,
//     so there is one `selected` value and no separate cursor state.
//
// The hook owns key handling and the roving tabindex; the component owns the
// `selected` value (the single source of truth) and renders the panels.

export interface TablistTabProps {
  role: "tab";
  tabIndex: 0 | -1;
  "aria-selected": boolean;
  "aria-controls": string;
  id: string;
  ref: (el: HTMLElement | null) => void;
  onClick: () => void;
  onKeyDown: (e: ReactKeyboardEvent) => void;
}

export interface TablistPanelProps {
  role: "tabpanel";
  id: string;
  "aria-labelledby": string;
}

export interface UseTablistResult<T extends string> {
  /** Props for the `role="tablist"` container. */
  tablistProps: { role: "tablist" };
  /** Props for one tab button, keyed by its id. */
  getTabProps: (tab: T) => TablistTabProps;
  /** Props for the panel a tab controls (`id`/`role`/`aria-labelledby`). */
  getPanelProps: (tab: T) => TablistPanelProps;
}

/**
 * Drives a tablist over the ordered `tabs`, with `selected` as the committed
 * tab and `onSelect` the commit. `idBase` namespaces the generated tab/panel
 * element ids so multiple tablists on one screen never collide.
 */
export function useTablist<T extends string>({
  tabs,
  selected,
  onSelect,
  idBase,
}: {
  tabs: readonly T[];
  selected: T;
  onSelect: (tab: T) => void;
  idBase: string;
}): UseTablistResult<T> {
  const tabRefs = useRef(new Map<T, HTMLElement>());

  const tabId = (tab: T) => `${idBase}-tab-${tab}`;
  const panelId = (tab: T) => `${idBase}-panel-${tab}`;

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      const current = indexOfId(tabs as readonly string[], selected);
      let target: T | null = null;
      switch (e.key) {
        case "ArrowRight":
        case "ArrowDown":
          target = tabs[nextIndex("next", current, tabs.length)] ?? null;
          break;
        case "ArrowLeft":
        case "ArrowUp":
          target = tabs[nextIndex("prev", current, tabs.length)] ?? null;
          break;
        case "Home":
          target = tabs[nextIndex("first", current, tabs.length)] ?? null;
          break;
        case "End":
          target = tabs[nextIndex("last", current, tabs.length)] ?? null;
          break;
        default:
          return;
      }
      e.preventDefault();
      if (target != null && target !== selected) {
        // Activation follows focus: commit and move focus together.
        onSelect(target);
        tabRefs.current.get(target)?.focus();
      }
    },
    [tabs, selected, onSelect],
  );

  const getTabProps = (tab: T): TablistTabProps => ({
    role: "tab",
    tabIndex: tab === selected ? 0 : -1,
    "aria-selected": tab === selected,
    "aria-controls": panelId(tab),
    id: tabId(tab),
    ref: (el) => {
      if (el) tabRefs.current.set(tab, el);
      else tabRefs.current.delete(tab);
    },
    onClick: () => onSelect(tab),
    onKeyDown,
  });

  const getPanelProps = (tab: T): TablistPanelProps => ({
    role: "tabpanel",
    id: panelId(tab),
    "aria-labelledby": tabId(tab),
  });

  return { tablistProps: { role: "tablist" }, getTabProps, getPanelProps };
}
