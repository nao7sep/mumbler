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

const REGION_COLOR = "rgba(29, 97, 118, 0.22)";
const MARKER_EPSILON_SEC = 0.05;

interface WaveformEditorProps {
  card: MumblerCard;
  previewSnippetSeconds: number;
  disabled: boolean;
  onDuplicateCard: (cardId: string) => Promise<void>;
  onTrimCommit: (cardId: string, trim: CardTrim) => Promise<void>;
  onError: (message: string) => void;
}

export interface WaveformEditorHandle {
  playPause(): Promise<void>;
  setFrontMarkerAtCursor(): Promise<void>;
  setBackMarkerAtCursor(): Promise<void>;
  playFirstSnippet(): Promise<void>;
  playLastSnippet(): Promise<void>;
}

export const WaveformEditor = forwardRef<WaveformEditorHandle, WaveformEditorProps>(function WaveformEditor({
  card,
  previewSnippetSeconds,
  disabled,
  onDuplicateCard,
  onTrimCommit,
  onError,
}, ref): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const waveSurferRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<RegionsPlugin | null>(null);
  const regionRef = useRef<Region | null>(null);
  const isSyncingRegionRef = useRef(false);
  const cardIdRef = useRef(card.id);
  const onTrimCommitRef = useRef(onTrimCommit);

  cardIdRef.current = card.id;
  onTrimCommitRef.current = onTrimCommit;

  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [isLoadingMedia, setIsLoadingMedia] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [cursorSec, setCursorSec] = useState(0);
  const [resolvedDurationSec, setResolvedDurationSec] = useState<number | null>(card.durationSec);
  const [draftTrim, setDraftTrim] = useState<CardTrim>(card.trim);
  const [frontInput, setFrontInput] = useState(formatMarkerInput(card.trim.frontMarkerSec));
  const [backInput, setBackInput] = useState(formatMarkerInput(card.trim.backMarkerSec));

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
      waveColor: "rgba(29, 97, 118, 0.2)",
      progressColor: "rgba(191, 79, 47, 0.84)",
      cursorColor: "#8f351b",
      barWidth: 2,
      barGap: 1.5,
      barRadius: 999,
      normalize: true,
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

    const subscriptions = [
      waveSurfer.on("ready", (duration) => {
        setResolvedDurationSec(duration);
      }),
      waveSurfer.on("decode", (duration) => {
        setResolvedDurationSec(duration);
      }),
      waveSurfer.on("play", () => {
        setIsPlaying(true);
      }),
      waveSurfer.on("pause", () => {
        setIsPlaying(false);
      }),
      waveSurfer.on("finish", () => {
        setIsPlaying(false);
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
      regions.on("region-update", (region) => {
        if (isSyncingRegionRef.current) {
          return;
        }

        const nextTrim = regionToTrim(region, waveSurfer.getDuration());
        setDraftTrim(nextTrim);
        setFrontInput(formatMarkerInput(nextTrim.frontMarkerSec));
        setBackInput(formatMarkerInput(nextTrim.backMarkerSec));
      }),
      regions.on("region-updated", (region) => {
        if (isSyncingRegionRef.current) {
          return;
        }

        const nextTrim = regionToTrim(region, waveSurfer.getDuration());
        void commitTrim(nextTrim);
      }),
      regions.on("region-removed", () => {
        if (isSyncingRegionRef.current) {
          return;
        }

        const clearedTrim = { frontMarkerSec: null, backMarkerSec: null };
        setDraftTrim(clearedTrim);
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

    syncRegionToTrim(regions, regionRef, draftTrim, durationSec, isSyncingRegionRef);
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

    await waveSurfer.play(startSec, endSec);
  }

  async function playPause(): Promise<void> {
    const waveSurfer = waveSurferRef.current;
    if (waveSurfer === null) {
      return;
    }

    await waveSurfer.playPause();
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
      setFrontMarkerAtCursor: () => setMarkerAtCursor("front"),
      setBackMarkerAtCursor: () => setMarkerAtCursor("back"),
      playFirstSnippet: () => playSnippet("first"),
      playLastSnippet: () => playSnippet("last"),
    }),
    [cursorSec, draftTrim.backMarkerSec, draftTrim.frontMarkerSec, previewSnippetSeconds, resolvedDurationSec],
  );

  const durationLabel = formatDurationLabel(resolvedDurationSec);
  const trimSummary = describeTrim(draftTrim);

  return (
    <div className="waveform-editor">
      <div className="waveform-editor__status">
        <span className="muted-tag">Cursor {formatMarkerInput(cursorSec)}</span>
        <span className="muted-tag">Duration {durationLabel}</span>
        <span className="muted-tag">{trimSummary}</span>
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
          disabled={disabled}
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
        <button type="button" className="button button--ghost" onClick={() => void playSnippet("first")}>
          Play First {previewSnippetSeconds}s
        </button>
        <button type="button" className="button button--ghost" onClick={() => void playSnippet("last")}>
          Play Last {previewSnippetSeconds}s
        </button>
      </div>

      <div className="trim-editor-grid">
        <section className="trim-editor-card">
          <div className="detail-card__header">
            <h4>Front Marker</h4>
            <span className="muted-tag">Shifts effective start</span>
          </div>
          <label className="field">
            <span>Keep audio from</span>
            <input
              value={frontInput}
              onChange={(event) => setFrontInput(event.target.value)}
              onBlur={() => void handleMarkerInputCommit("front")}
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
          <div className="detail-card__header">
            <h4>Back Marker</h4>
            <span className="muted-tag">Keep audio until</span>
          </div>
          <label className="field">
            <span>Discard audio after</span>
            <input
              value={backInput}
              onChange={(event) => setBackInput(event.target.value)}
              onBlur={() => void handleMarkerInputCommit("back")}
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

function syncRegionToTrim(
  regions: RegionsPlugin,
  regionRef: MutableRefObject<Region | null>,
  trim: CardTrim,
  durationSec: number,
  isSyncingRegionRef: MutableRefObject<boolean>,
): void {
  const hasTrim = trim.frontMarkerSec !== null || trim.backMarkerSec !== null;
  const startSec = trim.frontMarkerSec ?? 0;
  const endSec = trim.backMarkerSec ?? durationSec;

  isSyncingRegionRef.current = true;

  try {
    if (!hasTrim) {
      regionRef.current?.remove();
      regionRef.current = null;
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
  } finally {
    window.setTimeout(() => {
      isSyncingRegionRef.current = false;
    }, 0);
  }
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
