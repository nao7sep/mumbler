import { useEffect, useState } from "react";

// The waveform canvas cannot resolve CSS variables, so its colors come from the
// --waveform-* tokens in styles.css. Those follow prefers-color-scheme (which
// follows the main process's nativeTheme.themeSource), so the palette is read
// again whenever that scheme changes; nothing here decides the theme itself.

export interface WaveformPalette {
  wave: string;
  progress: string;
  cursor: string;
  region: string;
}

export function readWaveformPalette(style: Pick<CSSStyleDeclaration, "getPropertyValue">): WaveformPalette {
  const token = (name: string): string => style.getPropertyValue(name).trim();
  return {
    wave: token("--waveform-wave"),
    progress: token("--waveform-progress"),
    cursor: token("--waveform-cursor"),
    region: token("--waveform-region"),
  };
}

function currentPalette(): WaveformPalette {
  return readWaveformPalette(getComputedStyle(document.documentElement));
}

export function useWaveformPalette(): WaveformPalette {
  const [palette, setPalette] = useState(currentPalette);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const refresh = (): void => setPalette(currentPalette());
    scheme.addEventListener("change", refresh);
    return () => scheme.removeEventListener("change", refresh);
  }, []);

  return palette;
}
