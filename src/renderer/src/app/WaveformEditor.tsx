import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type MutableRefObject,
  type ReactElement,
} from "react";

import WaveSurfer from "wavesurfer.js";
import RegionsPlugin, { type Region } from "wavesurfer.js/dist/plugins/regions.esm.js";

import type { CardTrim, MumblerCard } from "@shared/app-shell";
import { useComposing, isComposingKeyboardEvent } from "./useComposing";

const REGION_COLOR = "rgba(61, 122, 90, 0.22)";
const WAVE_COLOR = "rgba(72, 108, 88, 0.24)";
const PROGRESS_COLOR = "rgba(47, 99, 74, 0.86)";
const CURSOR_COLOR = "#2f634a";
const MARKER_EPSILON_SEC = 0.05;

// Renders a symmetric waveform by merging all channels and centering bars.
// WaveSurfer's default renderer uses separate stereo channels for top/bottom halves,
// which produces visually asymmetric results for mono-dominant recordings.
function renderSymmetricWaveform(
  channelData: Array<Float32Array | number[]>,
  ctx: CanvasRenderingContext2D,
): void {
  const { width, height } = ctx.canvas;
  const halfH = height / 2;
  const pixelRatio = window.devicePixelRatio ?? 1;
  const barWidth = 2 * pixelRatio;
  const barStep = barWidth + 1.5 * pixelRatio;

  const length = channelData[0]?.length ?? 0;
  if (length === 0) return;

  // Normalize against the global max across all channels.
  let maxPeak = 0;
  for (const ch of channelData) {
    for (let i = 0; i < ch.length; i++) {
      const abs = Math.abs(ch[i]);
      if (abs > maxPeak) maxPeak = abs;
    }
  }
  if (maxPeak === 0) return;

  const numBars = Math.floor(width / barStep);
  if (numBars === 0) return;
  const samplesPerBar = length / numBars;

  ctx.beginPath();
  for (let b = 0; b < numBars; b++) {
    const start = Math.round(b * samplesPerBar);
    const end = Math.min(length, Math.round((b + 1) * samplesPerBar));
    if (start >= end) continue;

    let barPeak = 0;
    for (let i = start; i < end; i++) {
      for (const ch of channelData) {
        const abs = Math.abs(ch[i] ?? 0);
        if (abs > barPeak) barPeak = abs;
      }
    }

    const amplitude = barPeak / maxPeak;
    const barH = Math.max(pixelRatio, Math.round(amplitude * halfH * 2));
    const x = b * barStep;
    const y = halfH - barH / 2;
    const radius = Math.min(pixelRatio, barH / 2);
    ctx.roundRect(x, y, barWidth, barH, radius);
  }
  ctx.fill();
}

interface WaveformEditorProps {
  card: MumblerCard;
  previewSnippetSeconds: number;
  skipIntervalSec: number;
  disabled: boolean;
  onDuplicateCard: (cardId: string) => Promise<void>;
  onTrimCommit: (cardId: string, trim: CardTrim) => Promise<void>;
  onError: (message: string) => void;
}

export interface WaveformEditorHandle {
  playPause(): Promise<void>;
  skipBackward(): void;
  skipForward(): void;
  setFrontMarkerAtCursor(): Promise<void>;
  setBackMarkerAtCursor(): Promise<void>;
  playFirstSnippet(): Promise<void>;
  playLastSnippet(): Promise<void>;
}

export const WaveformEditor = forwardRef<WaveformEditorHandle, WaveformEditorProps>(function WaveformEditor({
  card,
  previewSnippetSeconds,
  skipIntervalSec,
  disabled,
  onDuplicateCard,
  onTrimCommit,
  onError,
}, ref): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const waveSurferRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<RegionsPlugin | null>(null);
  const regionRef = useRef<Region | null>(null);
  const cardIdRef = useRef(card.id);
  const onTrimCommitRef = useRef(onTrimCommit);

  cardIdRef.current = card.id;
  onTrimCommitRef.current = onTrimCommit;

  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [isLoadingMedia, setIsLoadingMedia] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [activeSnippet, setActiveSnippet] = useState<"first" | "last" | null>(null);
  const [cursorSec, setCursorSec] = useState(0);
  const [resolvedDurationSec, setResolvedDurationSec] = useState<number | null>(card.durationSec);
  const [draftTrim, setDraftTrim] = useState<CardTrim>(card.trim);
  const [frontInput, setFrontInput] = useState(formatMarkerInput(card.trim.frontMarkerSec));
  const [backInput, setBackInput] = useState(formatMarkerInput(card.trim.backMarkerSec));

  const frontComposing = useComposing();
  const backComposing = useComposing();

  // Keep a ref to draftTrim so the WaveSurfer 'ready' handler can access the
  // current value without going stale inside the [mediaUrl] effect closure.
  const draftTrimRef = useRef(draftTrim);
  draftTrimRef.current = draftTrim;

  useEffect(() => {
    setDraftTrim(card.trim);
    setFrontInput(formatMarkerInput(card.trim.frontMarkerSec));
    setBackInput(formatMarkerInput(card.trim.backMarkerSec));
  }, [card.id, card.trim.backMarkerSec, card.trim.frontMarkerSec]);

  useEffect(() => {
    setResolvedDurationSec(card.durationSec);
  }, [card.durationSec, card.id]);

  useEffect(() => {
    let cancelled = false;
    setIsLoadingMedia(true);
    setPlayerError(null);

    void window.mumbler
      .getCardMediaSource(card.id)
      .then((nextMediaUrl) => {
        if (cancelled) {
          return;
        }

        setMediaUrl(nextMediaUrl);
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }

        const message =
          error instanceof Error ? error.message : "Failed to load working audio for playback.";
        setPlayerError(message);
        onError(message);
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingMedia(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [card.id]);

  useEffect(() => {
    if (containerRef.current === null || mediaUrl === null) {
      return;
    }

    const regions = RegionsPlugin.create();
    const waveSurfer = WaveSurfer.create({
      container: containerRef.current,
      height: 184,
      waveColor: WAVE_COLOR,
      progressColor: PROGRESS_COLOR,
      cursorColor: CURSOR_COLOR,
      renderFunction: renderSymmetricWaveform,
      dragToSeek: true,
      autoScroll: true,
      autoCenter: true,
      url: mediaUrl,
      plugins: [regions],
    });

    waveSurferRef.current = waveSurfer;
    regionsRef.current = regions;
    regionRef.current = null;
    setCursorSec(0);
    setIsPlaying(false);
    setActiveSnippet(null);

    const subscriptions = [
      waveSurfer.on("ready", (duration) => {
        setResolvedDurationSec(duration);
        // Sync region immediately after WaveSurfer is ready. Without this,
        // if resolvedDurationSec doesn't change (already matches card.durationSec),
        // React skips the re-render and the sync effect never runs after WaveSurfer loads.
        if (duration > 0) {
          syncRegionToTrim(regions, regionRef, draftTrimRef.current, duration);
        }
      }),
      waveSurfer.on("decode", (duration) => {
        setResolvedDurationSec(duration);
      }),
      waveSurfer.on("play", () => {
        setIsPlaying(true);
      }),
      waveSurfer.on("pause", () => {
        setIsPlaying(false);
        setActiveSnippet(null);
      }),
      waveSurfer.on("finish", () => {
        setIsPlaying(false);
        setActiveSnippet(null);
      }),
      waveSurfer.on("timeupdate", (currentTime) => {
        setCursorSec(currentTime);
      }),
      waveSurfer.on("interaction", (nextTime) => {
        setCursorSec(nextTime);
      }),
      waveSurfer.on("error", (error) => {
        const message = error instanceof Error ? error.message : String(error);
        setPlayerError(message);
        onError(message);
      }),
      // region-update / region-updated fire only from a user drag or resize:
      // WaveSurfer's programmatic setOptions emits "render", not "update", so
      // syncing the region to our own state never echoes back through these.
      regions.on("region-update", (region) => {
        const nextTrim = regionToTrim(region, waveSurfer.getDuration());
        setDraftTrim(nextTrim);
        setFrontInput(formatMarkerInput(nextTrim.frontMarkerSec));
        setBackInput(formatMarkerInput(nextTrim.backMarkerSec));
      }),
      regions.on("region-updated", (region) => {
        const nextTrim = regionToTrim(region, waveSurfer.getDuration());
        void commitTrim(nextTrim);
      }),
      regions.on("region-removed", () => {
        // A removal we initiated clears regionRef *before* calling remove(), so a
        // null ref here means this is the synchronous echo of our own sync —
        // ignore it. No user gesture removes the region, so the body below only
        // runs if some external force did, in which case we mirror the cleared state.
        if (regionRef.current === null) {
          return;
        }

        setDraftTrim({ frontMarkerSec: null, backMarkerSec: null });
        setFrontInput("");
        setBackInput("");
      }),
    ];

    return () => {
      for (const unsubscribe of subscriptions) {
        unsubscribe();
      }

      regionRef.current = null;
      regionsRef.current = null;
      waveSurferRef.current?.destroy();
      waveSurferRef.current = null;
    };
  }, [mediaUrl]);

  useEffect(() => {
    const waveSurfer = waveSurferRef.current;
    const regions = regionsRef.current;
    const durationSec = resolvedDurationSec ?? waveSurfer?.getDuration() ?? null;

    if (waveSurfer === null || regions === null || durationSec === null || durationSec <= 0) {
      return;
    }

    syncRegionToTrim(regions, regionRef, draftTrim, durationSec);
  }, [draftTrim.backMarkerSec, draftTrim.frontMarkerSec, resolvedDurationSec]);

  async function commitTrim(nextTrim: CardTrim): Promise<void> {
    try {
      const normalizedTrim = normalizeTrimDraft(nextTrim, resolvedDurationSec);
      setDraftTrim(normalizedTrim);
      setFrontInput(formatMarkerInput(normalizedTrim.frontMarkerSec));
      setBackInput(formatMarkerInput(normalizedTrim.backMarkerSec));
      setPlayerError(null);
      await onTrimCommitRef.current(cardIdRef.current, normalizedTrim);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to update trim markers.";
      setPlayerError(message);
      setDraftTrim(card.trim);
      setFrontInput(formatMarkerInput(card.trim.frontMarkerSec));
      setBackInput(formatMarkerInput(card.trim.backMarkerSec));
      onError(message);
      throw error;
    }
  }

  async function setMarkerAtCursor(side: "front" | "back"): Promise<void> {
    try {
      const currentTime = cursorSec;
      const nextTrim =
        side === "front"
          ? {
              frontMarkerSec: currentTime,
              backMarkerSec: draftTrim.backMarkerSec,
            }
          : {
              frontMarkerSec: draftTrim.frontMarkerSec,
              backMarkerSec: currentTime,
            };

      await commitTrim(nextTrim);
    } catch {
      return;
    }
  }

  async function nudgeMarker(side: "front" | "back", deltaSec: number): Promise<void> {
    try {
      const currentValue =
        side === "front" ? draftTrim.frontMarkerSec ?? 0 : draftTrim.backMarkerSec ?? 0;
      const nextValue = currentValue + deltaSec;
      const nextTrim =
        side === "front"
          ? {
              frontMarkerSec: nextValue,
              backMarkerSec: draftTrim.backMarkerSec,
            }
          : {
              frontMarkerSec: draftTrim.frontMarkerSec,
              backMarkerSec: nextValue,
            };

      await commitTrim(nextTrim);
    } catch {
      return;
    }
  }

  async function handleMarkerInputCommit(side: "front" | "back"): Promise<void> {
    const rawValue = side === "front" ? frontInput : backInput;

    try {
      const parsed = parseMarkerInput(rawValue);
      const nextTrim =
        side === "front"
          ? { frontMarkerSec: parsed, backMarkerSec: draftTrim.backMarkerSec }
          : { frontMarkerSec: draftTrim.frontMarkerSec, backMarkerSec: parsed };

      await commitTrim(nextTrim);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Invalid trim marker.";
      setPlayerError(message);
      onError(message);
    }
  }

  async function clearMarkers(): Promise<void> {
    try {
      await commitTrim({ frontMarkerSec: null, backMarkerSec: null });
    } catch {
      return;
    }
  }

  async function playSnippet(side: "first" | "last"): Promise<void> {
    const waveSurfer = waveSurferRef.current;
    const durationSec = resolvedDurationSec ?? waveSurfer?.getDuration() ?? null;

    if (waveSurfer === null || durationSec === null) {
      return;
    }

    const span = Math.min(previewSnippetSeconds, durationSec);
    const preservedStart = draftTrim.frontMarkerSec ?? 0;
    const preservedEnd = draftTrim.backMarkerSec ?? durationSec;
    const startSec =
      side === "first" ? preservedStart : Math.max(0, preservedEnd - span);
    const endSec =
      side === "first"
        ? Math.min(durationSec, preservedStart + span)
        : Math.min(durationSec, preservedEnd);

    setActiveSnippet(side);
    await waveSurfer.play(startSec, endSec);
  }

  async function playPause(): Promise<void> {
    const waveSurfer = waveSurferRef.current;
    if (waveSurfer === null) {
      return;
    }

    setActiveSnippet(null);
    await waveSurfer.playPause();
  }

  function skipSeconds(seconds: number): void {
    const waveSurfer = waveSurferRef.current;
    if (waveSurfer === null) {
      return;
    }

    const duration = waveSurfer.getDuration();
    const next = Math.max(0, Math.min(duration, waveSurfer.getCurrentTime() + seconds));
    waveSurfer.setTime(next);
  }

  async function duplicateCard(): Promise<void> {
    try {
      await onDuplicateCard(card.id);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to duplicate card.";
      setPlayerError(message);
      onError(message);
    }
  }

  function onMarkerInputKeyDown(
    side: "front" | "back",
    event: KeyboardEvent<HTMLInputElement>,
  ): void {
    const composing = side === "front" ? frontComposing : backComposing;
    if (isComposingKeyboardEvent(composing.composingRef, event)) {
      return;
    }
    if (event.key !== "Enter") {
      return;
    }

    event.preventDefault();
    void handleMarkerInputCommit(side);
  }

  useImperativeHandle(
    ref,
    () => ({
      playPause,
      skipBackward: () => skipSeconds(-skipIntervalSec),
      skipForward: () => skipSeconds(skipIntervalSec),
      setFrontMarkerAtCursor: () => setMarkerAtCursor("front"),
      setBackMarkerAtCursor: () => setMarkerAtCursor("back"),
      playFirstSnippet: () => playSnippet("first"),
      playLastSnippet: () => playSnippet("last"),
    }),
    [cursorSec, draftTrim.backMarkerSec, draftTrim.frontMarkerSec, previewSnippetSeconds, skipIntervalSec, resolvedDurationSec],
  );

  const durationLabel = formatDurationLabel(resolvedDurationSec);
  const trimSummary = describeTrim(draftTrim);

  return (
    <div className="waveform-editor">
      <div className="waveform-editor__info">
        <span className="waveform-editor__info-item">Cursor: {formatMarkerInput(cursorSec)}</span>
        <span className="waveform-editor__info-item">Duration: {durationLabel}</span>
        <span className="waveform-editor__info-item">{trimSummary}</span>
      </div>

      <div className="waveform-canvas" ref={containerRef} />

      {isLoadingMedia ? (
        <p className="panel__note">Loading working audio…</p>
      ) : null}
      {playerError ? <p className="inline-error">{playerError}</p> : null}

      <div className="control-row control-row--five">
        <button type="button" className="button button--ghost" onClick={() => void playPause()}>
          {isPlaying ? "Pause" : "Play"}
        </button>
        <button
          type="button"
          className="button button--ghost"
          onClick={() => void setMarkerAtCursor("front")}
          disabled={disabled}
        >
          Set Front at Cursor
        </button>
        <button
          type="button"
          className="button button--ghost"
          onClick={() => void setMarkerAtCursor("back")}
          disabled={disabled}
        >
          Set Back at Cursor
        </button>
        <button
          type="button"
          className="button button--ghost"
          onClick={() => void clearMarkers()}
          disabled={disabled || (draftTrim.frontMarkerSec === null && draftTrim.backMarkerSec === null)}
        >
          Clear Markers
        </button>
        <button
          type="button"
          className="button button--ghost"
          onClick={() => void duplicateCard()}
          disabled={disabled}
        >
          Duplicate Card
        </button>
      </div>

      <div className="control-row control-row--two">
        <button
          type="button"
          className={`button ${activeSnippet === "first" && isPlaying ? "button--primary" : "button--ghost"}`}
          aria-pressed={activeSnippet === "first" && isPlaying}
          onClick={() => void playSnippet("first")}
        >
          Play First {previewSnippetSeconds}s
        </button>
        <button
          type="button"
          className={`button ${activeSnippet === "last" && isPlaying ? "button--primary" : "button--ghost"}`}
          aria-pressed={activeSnippet === "last" && isPlaying}
          onClick={() => void playSnippet("last")}
        >
          Play Last {previewSnippetSeconds}s
        </button>
      </div>

      <div className="trim-editor-grid">
        <section className="trim-editor-card">
          <h4>Front Marker</h4>
          <label className="field">
            <span>Keep audio from</span>
            <input
              value={frontInput}
              onChange={(event) => setFrontInput(event.target.value)}
              onBlur={() => void handleMarkerInputCommit("front")}
              onCompositionStart={frontComposing.handlers.onCompositionStart}
              onCompositionEnd={frontComposing.handlers.onCompositionEnd}
              onKeyDown={(event) => onMarkerInputKeyDown("front", event)}
              placeholder="mm:ss.s"
              disabled={disabled}
            />
          </label>
          <div className="nudge-grid">
            <button
              type="button"
              className="button button--ghost"
              onClick={() => void nudgeMarker("front", -1)}
              disabled={disabled}
            >
              -1.0s
            </button>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => void nudgeMarker("front", -0.1)}
              disabled={disabled}
            >
              -0.1s
            </button>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => void nudgeMarker("front", 0.1)}
              disabled={disabled}
            >
              +0.1s
            </button>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => void nudgeMarker("front", 1)}
              disabled={disabled}
            >
              +1.0s
            </button>
          </div>
        </section>

        <section className="trim-editor-card">
          <h4>Back Marker</h4>
          <label className="field">
            <span>Discard audio after</span>
            <input
              value={backInput}
              onChange={(event) => setBackInput(event.target.value)}
              onBlur={() => void handleMarkerInputCommit("back")}
              onCompositionStart={backComposing.handlers.onCompositionStart}
              onCompositionEnd={backComposing.handlers.onCompositionEnd}
              onKeyDown={(event) => onMarkerInputKeyDown("back", event)}
              placeholder="mm:ss.s"
              disabled={disabled}
            />
          </label>
          <div className="nudge-grid">
            <button
              type="button"
              className="button button--ghost"
              onClick={() => void nudgeMarker("back", -1)}
              disabled={disabled}
            >
              -1.0s
            </button>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => void nudgeMarker("back", -0.1)}
              disabled={disabled}
            >
              -0.1s
            </button>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => void nudgeMarker("back", 0.1)}
              disabled={disabled}
            >
              +0.1s
            </button>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => void nudgeMarker("back", 1)}
              disabled={disabled}
            >
              +1.0s
            </button>
          </div>
        </section>
      </div>
    </div>
  );
});

// Pushes our trim state into the WaveSurfer region. This is the programmatic half
// of the two-way sync; the user-driven half lives in the region-* handlers. No
// guard flag is needed because addRegion/setOptions don't emit the region-update
// events those handlers react to (they emit "render"). The only echo is the
// synchronous "region-removed" on remove(), which the handler recognizes by
// regionRef already being null.
function syncRegionToTrim(
  regions: RegionsPlugin,
  regionRef: MutableRefObject<Region | null>,
  trim: CardTrim,
  durationSec: number,
): void {
  const hasTrim = trim.frontMarkerSec !== null || trim.backMarkerSec !== null;
  const startSec = trim.frontMarkerSec ?? 0;
  const endSec = trim.backMarkerSec ?? durationSec;

  if (!hasTrim) {
    // Detach our reference before removing so the synchronous "region-removed"
    // echo sees a null ref and is ignored as self-inflicted.
    const existing = regionRef.current;
    regionRef.current = null;
    existing?.remove();
    return;
  }

  if (regionRef.current === null) {
    regionRef.current = regions.addRegion({
      id: "keep-range",
      start: startSec,
      end: endSec,
      drag: false,
      resize: true,
      resizeStart: true,
      resizeEnd: true,
      color: REGION_COLOR,
    });
    return;
  }

  regionRef.current.setOptions({
    start: startSec,
    end: endSec,
    drag: false,
    resize: true,
    resizeStart: true,
    resizeEnd: true,
    color: REGION_COLOR,
  });
}

function regionToTrim(region: Region, durationSec: number): CardTrim {
  const normalizedFront = region.start <= MARKER_EPSILON_SEC ? null : roundTenths(region.start);
  const normalizedBack =
    durationSec - region.end <= MARKER_EPSILON_SEC ? null : roundTenths(region.end);

  return {
    frontMarkerSec: normalizedFront,
    backMarkerSec: normalizedBack,
  };
}

function normalizeTrimDraft(trim: CardTrim, durationSec: number | null): CardTrim {
  const frontMarkerSec = normalizeMarker(trim.frontMarkerSec, durationSec);
  const backMarkerSec = normalizeMarker(trim.backMarkerSec, durationSec);

  if (frontMarkerSec !== null && backMarkerSec !== null && frontMarkerSec >= backMarkerSec) {
    throw new Error("Front trim must be earlier than back trim.");
  }

  return {
    frontMarkerSec,
    backMarkerSec,
  };
}

function normalizeMarker(value: number | null, durationSec: number | null): number | null {
  if (value === null) {
    return null;
  }

  if (!Number.isFinite(value)) {
    throw new Error("Trim markers must be numeric.");
  }

  if (value < 0) {
    throw new Error("Trim markers cannot be negative.");
  }

  const rounded = roundTenths(value);

  if (durationSec !== null && rounded > durationSec) {
    throw new Error("Trim marker cannot exceed audio duration.");
  }

  return rounded <= 0 ? null : rounded;
}

function parseMarkerInput(rawValue: string): number | null {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const parts = trimmed.split(":");
  if (parts.some((part) => part.trim().length === 0)) {
    throw new Error("Trim markers must use mm:ss.s format.");
  }

  if (parts.length === 1) {
    const seconds = Number(parts[0]);
    if (!Number.isFinite(seconds)) {
      throw new Error("Trim marker must be numeric.");
    }
    return seconds;
  }

  if (parts.length === 2) {
    const minutes = Number(parts[0]);
    const seconds = Number(parts[1]);
    if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) {
      throw new Error("Trim marker must be numeric.");
    }
    return minutes * 60 + seconds;
  }

  if (parts.length === 3) {
    const hours = Number(parts[0]);
    const minutes = Number(parts[1]);
    const seconds = Number(parts[2]);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
      throw new Error("Trim marker must be numeric.");
    }
    return hours * 3600 + minutes * 60 + seconds;
  }

  throw new Error("Trim markers must use mm:ss.s format.");
}

function formatMarkerInput(value: number | null): string {
  if (value === null) {
    return "";
  }

  const totalTenths = Math.round(value * 10);
  const totalSeconds = Math.floor(totalTenths / 10);
  const tenths = totalTenths % 10;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}.${tenths}`;
}

function formatDurationLabel(value: number | null): string {
  if (value === null) {
    return "Unknown";
  }

  return formatMarkerInput(value);
}

function describeTrim(trim: CardTrim): string {
  if (trim.frontMarkerSec === null && trim.backMarkerSec === null) {
    return "No trim markers";
  }

  const front = trim.frontMarkerSec === null ? "0:00.0" : formatMarkerInput(trim.frontMarkerSec);
  const back = trim.backMarkerSec === null ? "end" : formatMarkerInput(trim.backMarkerSec);
  return `Keep ${front} to ${back}`;
}

function roundTenths(value: number): number {
  return Math.round(value * 10) / 10;
}
