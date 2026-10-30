import {
  forwardRef,
  useEffect,
  useId,
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
import { useI18n } from "../i18n/I18nContext";
import { message, type Message } from "@shared/i18n/translate";
import { InlineError } from "./InlineResult";
import { useComposing, isComposingKeyboardEvent } from "./useComposing";
import { presentFailure } from "./presentFailure";
import { useWaveformPalette } from "./waveform-palette";
import { WAVEFORM_PEAKS_PER_SECOND } from "@shared/waveform";

type Regions = ReturnType<typeof RegionsPlugin.create>;

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

type MarkerSide = "front" | "back";
interface TypedMarker {
  text: string;
}
interface TypedMarkers {
  front: TypedMarker | null;
  back: TypedMarker | null;
}

interface WaveformEditorProps {
  card: MumblerCard;
  previewSnippetSeconds: number;
  skipIntervalSec: number;
  disabled: boolean;
  onTrimCommit: (cardId: string, trim: CardTrim) => Promise<void>;
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
  onTrimCommit,
}, ref): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const waveSurferRef = useRef<WaveSurfer | null>(null);
  const playerCardIdRef = useRef<string | null>(null);
  const regionsRef = useRef<Regions | null>(null);
  const regionRef = useRef<Region | null>(null);
  // Theme colors for the canvas; the ref lets the create-once effect and the
  // region sync read the current palette without re-creating the player.
  const palette = useWaveformPalette();
  const paletteRef = useRef(palette);
  paletteRef.current = palette;
  const cardIdRef = useRef(card.id);
  const onTrimCommitRef = useRef(onTrimCommit);
  const disabledRef = useRef(disabled);

  cardIdRef.current = card.id;
  onTrimCommitRef.current = onTrimCommit;
  disabledRef.current = disabled;

  const [mediaSource, setMediaSource] = useState<{ cardId: string; url: string } | null>(null);
  // The waveform summary the main process computes from a stream of the file
  // (computeWaveformPeaks). The player never downloads the recording: it draws
  // this, and its audio element streams the file through the media handler.
  const [peaks, setPeaks] = useState<{ cardId: string; data: Float32Array } | null>(null);
  const [waveformState, setWaveformState] = useState<"drawing" | "drawn" | "failed">("drawing");
  const peaksRef = useRef(peaks);
  peaksRef.current = peaks;
  // Which summary the current player draws, so arriving peaks replace only a placeholder.
  const drawnPeaksRef = useRef<Float32Array | null>(null);
  const i18n = useI18n();
  const { t, text } = i18n;
  const markerErrorId = useId();
  const [playerError, setPlayerError] = useState<Message | null>(null);
  const [isLoadingMedia, setIsLoadingMedia] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [activeSnippet, setActiveSnippet] = useState<"first" | "last" | null>(null);
  const [cursorSec, setCursorSec] = useState(0);
  const [resolvedDurationSec, setResolvedDurationSec] = useState<number | null>(card.durationSec);
  const [draftTrim, setDraftTrim] = useState<CardTrim>(card.trim);
  const [frontInput, setFrontInput] = useState(formatMarkerInput(card.trim.frontMarkerSec));
  const [backInput, setBackInput] = useState(formatMarkerInput(card.trim.backMarkerSec));
  // Marker text typed but not yet committed, per side, survives a snapshot of
  // the card's saved trim and, per card, a switch to another card and back for
  // the session (unsaved-edits-conventions). Null means the side shows the
  // saved value.
  const typedRef = useRef<TypedMarkers>({ front: null, back: null });
  const typedByCardRef = useRef(new Map<string, TypedMarkers>());
  const shownCardRef = useRef(card.id);
  // Each card's pending owner retains its latest submitted range so returning
  // before settlement cannot replace it with an earlier saved snapshot.
  const pendingCommitsRef = useRef(new Map<string, { count: number; trim: CardTrim }>());
  const cardTrimRef = useRef(card.trim);
  cardTrimRef.current = card.trim;

  const frontComposing = useComposing();
  const backComposing = useComposing();

  // Keep a ref to draftTrim so the WaveSurfer 'ready' handler can access the
  // current value without going stale inside the media-source effect closure.
  const draftTrimRef = useRef(draftTrim);
  draftTrimRef.current = draftTrim;

  function showTrim(trim: CardTrim): void {
    setFrontInput(typedRef.current.front?.text ?? formatMarkerInput(trim.frontMarkerSec));
    setBackInput(typedRef.current.back?.text ?? formatMarkerInput(trim.backMarkerSec));
  }

  function keepTypedMarkers(cardId: string, typed: TypedMarkers): void {
    if (typed.front !== null || typed.back !== null) typedByCardRef.current.set(cardId, typed);
    else typedByCardRef.current.delete(cardId);
    if (shownCardRef.current === cardId) typedRef.current = typed;
  }

  function typeMarker(side: MarkerSide, value: string): void {
    if (cardIdRef.current !== card.id || shownCardRef.current !== card.id) return;
    // Object identity is the edit's version, including a later edit that happens
    // to contain the same text as an earlier submitted version.
    keepTypedMarkers(card.id, { ...typedRef.current, [side]: { text: value } });
    if (side === "front") setFrontInput(value);
    else setBackInput(value);
  }

  function currentPlayer(): WaveSurfer | null {
    return cardIdRef.current === card.id && playerCardIdRef.current === card.id
      ? waveSurferRef.current
      : null;
  }

  useEffect(() => {
    const returning = shownCardRef.current !== card.id;
    if (returning) {
      typedRef.current = typedByCardRef.current.get(card.id) ?? { front: null, back: null };
      shownCardRef.current = card.id;
    }
    const pending = pendingCommitsRef.current.get(card.id);
    if (pending) {
      if (returning) {
        draftTrimRef.current = pending.trim;
        setDraftTrim(pending.trim);
      }
      showTrim(draftTrimRef.current);
      return;
    }
    setDraftTrim(card.trim);
    showTrim(card.trim);
  }, [card.id, card.trim.backMarkerSec, card.trim.frontMarkerSec]);

  useEffect(() => {
    setResolvedDurationSec(card.durationSec);
  }, [card.durationSec, card.id]);

  useEffect(() => {
    let cancelled = false;
    setMediaSource(null);
    setCursorSec(0);
    setIsPlaying(false);
    setActiveSnippet(null);
    setIsLoadingMedia(true);
    setPlayerError(null);

    void window.mumbler
      .getCardMediaSource(card.id)
      .then((nextMediaUrl) => {
        if (cancelled) {
          return;
        }

        setMediaSource({ cardId: card.id, url: nextMediaUrl });
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }

        setPlayerError(presentFailure(error, message("player.loadFailed"), "working audio load failed"));
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
    let cancelled = false;
    const requestId = crypto.randomUUID();
    setPeaks(null);
    setWaveformState("drawing");
    void window.mumbler
      .getCardWaveformPeaks(card.id, requestId)
      .then((data) => {
        // Null is a run stopped on its way out, as this player closes.
        if (cancelled || data === null) return;
        setPeaks({ cardId: card.id, data });
        setWaveformState("drawn");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // Playback and trimming do not need the drawing, so only it is lost.
        presentFailure(error, message("player.waveformFailed"), "waveform summary failed");
        setWaveformState("failed");
      });
    return () => {
      cancelled = true;
      void window.mumbler.cancelCardWaveformPeaks(requestId).catch(() => undefined);
    };
  }, [card.id]);

  // The duration the player is built on: the recording's probed one, or, when
  // the probe found none, the summary's length once it arrives.
  const shownPeaks = peaks !== null && peaks.cardId === card.id ? peaks.data : null;
  const playerDurationSec = card.durationSec ?? (shownPeaks !== null && shownPeaks.length > 0 ? shownPeaks.length / WAVEFORM_PEAKS_PER_SECOND : null);

  useEffect(() => {
    if (containerRef.current === null || mediaSource === null || mediaSource.cardId !== card.id || playerDurationSec === null || playerDurationSec <= 0) {
      return;
    }

    const loadedCardId = mediaSource.cardId;
    let active = true;
    const regions = RegionsPlugin.create();
    // The player's own audio element, given to WaveSurfer so that drawing the
    // summary when it arrives never pauses playback. It streams the file.
    const media = document.createElement("audio");
    media.preload = "metadata";
    const ready = peaksRef.current !== null && peaksRef.current.cardId === loadedCardId ? peaksRef.current.data : null;
    drawnPeaksRef.current = ready;
    const waveSurfer = WaveSurfer.create({
      container: containerRef.current,
      height: 184,
      waveColor: paletteRef.current.wave,
      progressColor: paletteRef.current.progress,
      cursorColor: paletteRef.current.cursor,
      renderFunction: renderSymmetricWaveform,
      dragToSeek: true,
      autoScroll: true,
      autoCenter: true,
      url: mediaSource.url,
      media,
      // Until the summary arrives, a silent placeholder: the timeline, the
      // cursor and the trim region work at once.
      peaks: [ready ?? Float32Array.of(0)],
      duration: playerDurationSec,
      plugins: [regions],
    });

    waveSurferRef.current = waveSurfer;
    playerCardIdRef.current = loadedCardId;
    regionsRef.current = regions;
    regionRef.current = null;
    setCursorSec(0);
    setIsPlaying(false);
    setActiveSnippet(null);

    const isCurrentPlayer = (): boolean => active && cardIdRef.current === loadedCardId && waveSurferRef.current === waveSurfer;
    const subscriptions = [
      waveSurfer.on("ready", (duration) => {
        if (!isCurrentPlayer()) return;
        setResolvedDurationSec(duration);
        // Sync region immediately after WaveSurfer is ready. Without this,
        // if resolvedDurationSec doesn't change (already matches card.durationSec),
        // React skips the re-render and the sync effect never runs after WaveSurfer loads.
        if (duration > 0) {
          syncRegionToTrim(regions, regionRef, draftTrimRef.current, duration, paletteRef.current.region, disabledRef.current);
        }
      }),
      waveSurfer.on("decode", (duration) => {
        if (!isCurrentPlayer()) return;
        setResolvedDurationSec(duration);
      }),
      waveSurfer.on("play", () => {
        if (!isCurrentPlayer()) return;
        setIsPlaying(true);
      }),
      waveSurfer.on("pause", () => {
        if (!isCurrentPlayer()) return;
        setIsPlaying(false);
        setActiveSnippet(null);
      }),
      waveSurfer.on("finish", () => {
        if (!isCurrentPlayer()) return;
        setIsPlaying(false);
        setActiveSnippet(null);
      }),
      waveSurfer.on("timeupdate", (currentTime) => {
        if (!isCurrentPlayer()) return;
        setCursorSec(currentTime);
      }),
      waveSurfer.on("interaction", (nextTime) => {
        if (!isCurrentPlayer()) return;
        setCursorSec(nextTime);
      }),
      waveSurfer.on("error", (error) => {
        if (!isCurrentPlayer()) return;
        setPlayerError(presentFailure(error, message("player.playFailed"), "audio playback failed"));
      }),
      // region-update / region-updated fire only from a user drag or resize:
      // WaveSurfer's programmatic setOptions emits "render", not "update", so
      // syncing the region to our own state never echoes back through these.
      regions.on("region-update", (region) => {
        if (!isCurrentPlayer() || disabledRef.current) return;
        const nextTrim = regionToTrim(region, waveSurfer.getDuration());
        setDraftTrim(nextTrim);
        typeMarker("front", formatMarkerInput(nextTrim.frontMarkerSec));
        typeMarker("back", formatMarkerInput(nextTrim.backMarkerSec));
      }),
      regions.on("region-updated", (region) => {
        if (!isCurrentPlayer() || disabledRef.current) return;
        const nextTrim = regionToTrim(region, waveSurfer.getDuration());
        void commitTrim(nextTrim, ["front", "back"], loadedCardId, waveSurfer.getDuration()).catch((error: unknown) => {
          if (!isCurrentPlayer()) return;
          setPlayerError(presentFailure(error, message("player.markersOutOfRange"), "trim region validation failed"));
        });
      }),
      regions.on("region-removed", () => {
        if (!isCurrentPlayer() || disabledRef.current) return;
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
      active = false;
      for (const unsubscribe of subscriptions) {
        unsubscribe();
      }

      regionRef.current = null;
      regionsRef.current = null;
      waveSurferRef.current = null;
      playerCardIdRef.current = null;
      drawnPeaksRef.current = null;
      waveSurfer.destroy();
      // WaveSurfer leaves an element it was given alone: stop it and let go of the file.
      media.pause();
      media.removeAttribute("src");
      media.load();
    };
  }, [mediaSource, card.id, playerDurationSec]);

  // The summary arrived after the player was built: draw it in place of the
  // placeholder. The source stays the same, so playback goes on undisturbed.
  useEffect(() => {
    const waveSurfer = currentPlayer();
    if (waveSurfer === null || shownPeaks === null || mediaSource === null || playerDurationSec === null) return;
    if (drawnPeaksRef.current === shownPeaks) return;
    drawnPeaksRef.current = shownPeaks;
    void waveSurfer.load(mediaSource.url, [shownPeaks], playerDurationSec).catch((error: unknown) => {
      presentFailure(error, message("player.waveformFailed"), "waveform draw failed");
      setWaveformState("failed");
    });
  }, [shownPeaks, mediaSource, playerDurationSec]);

  useEffect(() => {
    const waveSurfer = currentPlayer();
    const regions = regionsRef.current;
    const durationSec = resolvedDurationSec ?? waveSurfer?.getDuration() ?? null;

    if (waveSurfer === null || regions === null || durationSec === null || durationSec <= 0) {
      return;
    }

    syncRegionToTrim(regions, regionRef, draftTrim, durationSec, paletteRef.current.region, disabled);
  }, [draftTrim.backMarkerSec, draftTrim.frontMarkerSec, resolvedDurationSec, disabled]);

  // Repaint the canvas and the keep-range when the theme's palette changes.
  useEffect(() => {
    waveSurferRef.current?.setOptions({
      waveColor: palette.wave,
      progressColor: palette.progress,
      cursorColor: palette.cursor,
    });
    regionRef.current?.setOptions({ color: palette.region });
  }, [palette]);

  // `sides` are the markers this commit sets. Their typed text stays until the
  // submitted version succeeds; a failure and later edits retain their drafts.
  // Draft ownership remains with the card even after its player is retired.
  // Settlement touches the view only while that card is shown. A failure restores
  // its saved range when no newer commit is pending, preserving all typed text.
  async function commitTrim(
    nextTrim: CardTrim,
    sides: readonly MarkerSide[] = ["front", "back"],
    submittedFor = card.id,
    durationSec = resolvedDurationSec,
  ): Promise<void> {
    if (disabledRef.current || cardIdRef.current !== submittedFor) return;
    const normalizedTrim = normalizeTrimDraft(nextTrim, durationSec);
    const submittedTyped = typedByCardRef.current.get(submittedFor) ?? { front: null, back: null };
    draftTrimRef.current = normalizedTrim;
    setDraftTrim(normalizedTrim);
    showTrim(normalizedTrim);
    setPlayerError(null);
    pendingCommitsRef.current.set(submittedFor, {
      count: (pendingCommitsRef.current.get(submittedFor)?.count ?? 0) + 1,
      trim: normalizedTrim,
    });
    let failure: unknown = null;
    try {
      await onTrimCommitRef.current(submittedFor, normalizedTrim);
    } catch (error: unknown) {
      failure = error;
    }
    const pending = pendingCommitsRef.current.get(submittedFor)!;
    const remaining = pending.count - 1;
    if (remaining === 0) pendingCommitsRef.current.delete(submittedFor);
    else pendingCommitsRef.current.set(submittedFor, { ...pending, count: remaining });
    if (failure === null) {
      let typed = typedByCardRef.current.get(submittedFor) ?? { front: null, back: null };
      for (const side of sides) {
        if (typed[side] === submittedTyped[side]) typed = { ...typed, [side]: null };
      }
      keepTypedMarkers(submittedFor, typed);
    }
    if (shownCardRef.current !== submittedFor || cardIdRef.current !== submittedFor) return;
    if (failure === null) {
      showTrim(draftTrimRef.current);
      return;
    }
    setPlayerError(presentFailure(failure, message("player.markersSaveFailed"), "trim marker save failed"));
    if (remaining === 0) {
      setDraftTrim(cardTrimRef.current);
      showTrim(cardTrimRef.current);
    }
  }

  async function setMarkerAtCursor(side: "front" | "back"): Promise<void> {
    if (disabledRef.current || currentPlayer() === null) return;
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

      await commitTrim(nextTrim, [side]);
    } catch {
      return;
    }
  }

  async function nudgeMarker(side: "front" | "back", deltaSec: number): Promise<void> {
    if (disabledRef.current || cardIdRef.current !== card.id) return;
    try {
      const currentValue =
        side === "front" ? draftTrim.frontMarkerSec ?? 0 : draftTrim.backMarkerSec ?? resolvedDurationSec;
      if (currentValue === null) return;
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

      await commitTrim(nextTrim, [side]);
    } catch {
      return;
    }
  }

  async function handleMarkerInputCommit(side: "front" | "back"): Promise<void> {
    if (disabledRef.current || cardIdRef.current !== card.id) return;
    const rawValue = side === "front" ? frontInput : backInput;
    const read = readMarkerInput(side, rawValue, resolvedDurationSec);
    // Invalid text already shows its error under the field and commits nothing,
    // so the markers saved last stay in force.
    if (!read.ok) return;

    try {
      const parsed = read.value;
      const nextTrim =
        side === "front"
          ? { frontMarkerSec: parsed, backMarkerSec: draftTrim.backMarkerSec }
          : { frontMarkerSec: draftTrim.frontMarkerSec, backMarkerSec: parsed };

      await commitTrim(nextTrim, [side]);
    } catch (error: unknown) {
      setPlayerError(presentFailure(error, message("player.markerInvalid"), "trim marker validation failed"));
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
    const waveSurfer = currentPlayer();
    const durationSec = resolvedDurationSec ?? waveSurfer?.getDuration() ?? null;

    if (waveSurfer === null || durationSec === null) {
      return;
    }

    const preservedStart = draftTrim.frontMarkerSec ?? 0;
    const preservedEnd = draftTrim.backMarkerSec ?? durationSec;
    const span = Math.min(previewSnippetSeconds, preservedEnd - preservedStart);
    const startSec = side === "first" ? preservedStart : preservedEnd - span;
    const endSec = side === "first" ? preservedStart + span : preservedEnd;

    setActiveSnippet(side);
    await waveSurfer.play(startSec, endSec);
  }

  async function playPause(): Promise<void> {
    const waveSurfer = currentPlayer();
    if (waveSurfer === null) {
      return;
    }

    setActiveSnippet(null);
    await waveSurfer.playPause();
  }

  function skipSeconds(seconds: number): void {
    const waveSurfer = currentPlayer();
    if (waveSurfer === null) {
      return;
    }

    const duration = waveSurfer.getDuration();
    const next = Math.max(0, Math.min(duration, waveSurfer.getCurrentTime() + seconds));
    waveSurfer.setTime(next);
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

  const frontRead = readMarkerInput("front", frontInput, resolvedDurationSec);
  const backRead = readMarkerInput("back", backInput, resolvedDurationSec);
  const frontIssue = frontRead.ok ? null : frontRead.issue;
  const backIssue = backRead.ok ? null : backRead.issue;

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
    [card.id, disabled, cursorSec, draftTrim.backMarkerSec, draftTrim.frontMarkerSec, previewSnippetSeconds, skipIntervalSec, resolvedDurationSec],
  );

  const hasCurrentMedia = mediaSource?.cardId === card.id;
  const durationLabel = resolvedDurationSec === null ? t("common.unknown") : formatMarkerInput(resolvedDurationSec);
  const trimSummary = text(describeTrim(draftTrim));

  return (
    <div className="waveform-editor">
      <div className="waveform-editor__info">
        <span className="waveform-editor__info-item">{t("player.cursor", { time: formatMarkerInput(cursorSec) })}</span>
        <span className="waveform-editor__info-item">{t("player.duration", { time: durationLabel })}</span>
        <span className="waveform-editor__info-item">{trimSummary}</span>
      </div>

      <div className="waveform-canvas" ref={containerRef} />

      {isLoadingMedia ? (
        <p className="panel__note">{t("player.loading")}</p>
      ) : waveformState === "drawing" ? (
        <p className="panel__note">{t("player.drawingWaveform")}</p>
      ) : waveformState === "failed" ? (
        <p className="panel__note">{t("player.waveformFailed")}</p>
      ) : null}
      {playerError ? <InlineError>{text(playerError)}</InlineError> : null}

      <div className="control-row">
        <button type="button" className="button button--ghost" onClick={() => void playPause()} disabled={!hasCurrentMedia}>
          {isPlaying ? t("player.pause") : t("player.play")}
        </button>
        <button
          type="button"
          className="button button--ghost"
          onClick={() => void setMarkerAtCursor("front")}
          disabled={disabled || !hasCurrentMedia}
        >
          {t("player.setFrontAtCursor")}
        </button>
        <button
          type="button"
          className="button button--ghost"
          onClick={() => void setMarkerAtCursor("back")}
          disabled={disabled || !hasCurrentMedia}
        >
          {t("player.setBackAtCursor")}
        </button>
        <button
          type="button"
          className="button button--ghost"
          onClick={() => void clearMarkers()}
          disabled={disabled || (draftTrim.frontMarkerSec === null && draftTrim.backMarkerSec === null)}
        >
          {t("player.clearMarkers")}
        </button>
      </div>

      <div className="control-row control-row--two">
        <button
          type="button"
          className={`button ${activeSnippet === "first" && isPlaying ? "button--primary" : "button--ghost"}`}
          aria-pressed={activeSnippet === "first" && isPlaying}
          onClick={() => void playSnippet("first")}
          disabled={!hasCurrentMedia}
        >
          {t("player.playFirst", { count: previewSnippetSeconds })}
        </button>
        <button
          type="button"
          className={`button ${activeSnippet === "last" && isPlaying ? "button--primary" : "button--ghost"}`}
          aria-pressed={activeSnippet === "last" && isPlaying}
          onClick={() => void playSnippet("last")}
          disabled={!hasCurrentMedia}
        >
          {t("player.playLast", { count: previewSnippetSeconds })}
        </button>
      </div>

      <div className="trim-editor-grid">
        <section className="trim-editor-card">
          <h4>{t("player.frontMarker")}</h4>
          <label className="field">
            <span>{t("player.keepFrom")}</span>
            <input
              value={frontInput}
              aria-invalid={frontIssue === null ? undefined : true}
              aria-describedby={frontIssue === null ? undefined : `${markerErrorId}-front`}
              onChange={(event) => typeMarker("front", event.target.value)}
              onBlur={() => void handleMarkerInputCommit("front")}
              onCompositionStart={frontComposing.handlers.onCompositionStart}
              onCompositionEnd={frontComposing.handlers.onCompositionEnd}
              onKeyDown={(event) => onMarkerInputKeyDown("front", event)}
              placeholder="mm:ss.s"
              disabled={disabled}
            />
          </label>
          {frontIssue === null ? null : <p className="field-error" id={`${markerErrorId}-front`}>{text(frontIssue)}</p>}
          <div className="nudge-grid">
            <button
              type="button"
              className="button button--ghost"
              onClick={() => void nudgeMarker("front", -1)}
              disabled={disabled}
            >
              {i18n.seconds(-1, { fractionDigits: 1, signed: true })}
            </button>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => void nudgeMarker("front", -0.1)}
              disabled={disabled}
            >
              {i18n.seconds(-0.1, { fractionDigits: 1, signed: true })}
            </button>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => void nudgeMarker("front", 0.1)}
              disabled={disabled}
            >
              {i18n.seconds(0.1, { fractionDigits: 1, signed: true })}
            </button>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => void nudgeMarker("front", 1)}
              disabled={disabled}
            >
              {i18n.seconds(1, { fractionDigits: 1, signed: true })}
            </button>
          </div>
        </section>

        <section className="trim-editor-card">
          <h4>{t("player.backMarker")}</h4>
          <label className="field">
            <span>{t("player.discardAfter")}</span>
            <input
              value={backInput}
              aria-invalid={backIssue === null ? undefined : true}
              aria-describedby={backIssue === null ? undefined : `${markerErrorId}-back`}
              onChange={(event) => typeMarker("back", event.target.value)}
              onBlur={() => void handleMarkerInputCommit("back")}
              onCompositionStart={backComposing.handlers.onCompositionStart}
              onCompositionEnd={backComposing.handlers.onCompositionEnd}
              onKeyDown={(event) => onMarkerInputKeyDown("back", event)}
              placeholder="mm:ss.s"
              disabled={disabled}
            />
          </label>
          {backIssue === null ? null : <p className="field-error" id={`${markerErrorId}-back`}>{text(backIssue)}</p>}
          <div className="nudge-grid">
            <button
              type="button"
              className="button button--ghost"
              onClick={() => void nudgeMarker("back", -1)}
              disabled={disabled}
            >
              {i18n.seconds(-1, { fractionDigits: 1, signed: true })}
            </button>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => void nudgeMarker("back", -0.1)}
              disabled={disabled}
            >
              {i18n.seconds(-0.1, { fractionDigits: 1, signed: true })}
            </button>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => void nudgeMarker("back", 0.1)}
              disabled={disabled}
            >
              {i18n.seconds(0.1, { fractionDigits: 1, signed: true })}
            </button>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => void nudgeMarker("back", 1)}
              disabled={disabled}
            >
              {i18n.seconds(1, { fractionDigits: 1, signed: true })}
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
  regions: Regions,
  regionRef: MutableRefObject<Region | null>,
  trim: CardTrim,
  durationSec: number,
  regionColor: string,
  disabled: boolean,
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
      resize: !disabled,
      resizeStart: !disabled,
      resizeEnd: !disabled,
      color: regionColor,
    });
    return;
  }

  regionRef.current.setOptions({
    start: startSec,
    end: endSec,
    drag: false,
    resize: !disabled,
    resizeStart: !disabled,
    resizeEnd: !disabled,
    color: regionColor,
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
  if (trim.backMarkerSec !== null && backMarkerSec === null) {
    throw new Error("The back trim cannot be 0.");
  }

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

type MarkerRead = { ok: true; value: number | null } | { ok: false; issue: Message };

// A typed marker: seconds, m:ss or h:mm:ss, the seconds to at most a tenth, and
// every part after a colon under 60. Empty means no trim on that side. The back
// marker cannot be 0, which would keep nothing; anything else is refused rather
// than corrected, with the reason shown under the field.
function readMarkerInput(side: MarkerSide, rawValue: string, durationSec: number | null): MarkerRead {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) return { ok: true, value: null };

  const parts = trimmed.split(":");
  const seconds = parts.at(-1)!;
  const leading = parts.slice(0, -1);
  const wellFormed = parts.length <= 3
    && /^\d+(?:\.\d)?$/.test(seconds)
    && leading.every((part) => /^\d+$/.test(part))
    && (parts.length === 1 || Number(seconds) < 60)
    && (parts.length < 3 || Number(parts[1]) < 60);
  if (!wellFormed) return { ok: false, issue: message("player.markerFormat") };

  const value = parts.reduce((total, part) => total * 60 + Number(part), 0);
  if (side === "back" && value === 0) return { ok: false, issue: message("player.backMarkerZero") };
  if (durationSec !== null && value > durationSec) return { ok: false, issue: message("player.markerInvalid") };
  return { ok: true, value: roundTenths(value) };
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

function describeTrim(trim: CardTrim): Message {
  if (trim.frontMarkerSec === null && trim.backMarkerSec === null) {
    return message("player.noTrimMarkers");
  }

  const front = trim.frontMarkerSec === null ? "0:00.0" : formatMarkerInput(trim.frontMarkerSec);
  return trim.backMarkerSec === null
    ? message("player.keepToEnd", { from: front })
    : message("player.keepRange", { from: front, to: formatMarkerInput(trim.backMarkerSec) });
}

function roundTenths(value: number): number {
  return Math.round(value * 10) / 10;
}
