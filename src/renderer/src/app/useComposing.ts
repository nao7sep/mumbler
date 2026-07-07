// Composition-aware keyboard event handling for IME support.
//
// When using an IME (e.g. Japanese, Chinese, Korean input), pressing Enter
// confirms character conversion rather than submitting a form. This hook
// tracks composition state so Enter-key handlers can distinguish between
// "user pressed Enter to confirm IME conversion" and "user pressed Enter
// to perform an action."
//
// Three-layer detection strategy (all checked by isComposingKeyboardEvent):
//
//   1. compositionstart/compositionend events set a ref flag. The compositionend
//      handler delays clearing via requestAnimationFrame because some renderers
//      fire compositionend BEFORE the final keydown event — without the delay,
//      the flag would already be false when the keydown handler runs.
//
//   2. KeyboardEvent.isComposing — broadly supported in modern browsers.
//
//   3. KeyboardEvent.keyCode === 229 — deprecated but historically the most
//      reliable signal across older Blink and WebKit IME implementations.

import { useCallback, useRef } from "react";

interface ComposingHandlers {
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
}

interface UseComposingReturn {
  composingRef: React.RefObject<boolean>;
  handlers: ComposingHandlers;
}

export function useComposing(): UseComposingReturn {
  const composingRef = useRef(false);
  const rafIdRef = useRef<number | null>(null);

  const onCompositionStart = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    composingRef.current = true;
  }, []);

  const onCompositionEnd = useCallback(() => {
    rafIdRef.current = requestAnimationFrame(() => {
      composingRef.current = false;
      rafIdRef.current = null;
    });
  }, []);

  return { composingRef, handlers: { onCompositionStart, onCompositionEnd } };
}

export function isComposingKeyboardEvent(
  composingRef: React.RefObject<boolean>,
  e: React.KeyboardEvent | KeyboardEvent,
): boolean {
  if (composingRef.current) return true;
  const nativeEvent = "nativeEvent" in e ? e.nativeEvent : e;
  if (nativeEvent.isComposing) return true;

  // Legacy fallback for older IME implementations. Confirmed empirically
  // necessary during dropkick's implementation — without this layer, IME
  // Enter still triggered handlers in some test runs.
  //
  // keyCode is deprecated and may eventually be removed from TypeScript's DOM
  // types; the cast below lets the build keep working in that case. At runtime
  // this is also safe: reading a missing property in JavaScript yields
  // undefined rather than throwing, so no try/catch is needed.
  const legacyKeyCode = (nativeEvent as { keyCode?: number }).keyCode;
  if (legacyKeyCode === 229) return true;

  return false;
}
