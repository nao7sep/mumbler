import {
  type AppPaths,
  type MumblerCard,
  type MumblerSettings,
  type MumblerState,
} from "@shared/app-shell";
import { isCardBusy } from "@shared/card-status";

import {
  executeCardPipeline,
  type CardPipelineContext,
  type PipelineMode,
  type PipelineStartStep,
} from "./card-pipeline";
import { type AppLogger } from "./logger";
import { OperationError } from "./operation-error";
import {
  TranscriptionSlotPool,
  selectNextQueuedCard,
  type TranscriptionSlot,
} from "./transcription-queue";

// The slice of the runtime the coordinator schedules against. ApplicationRuntime
// passes its own live state bag (which satisfies this view structurally), so the
// coordinator and the runtime always see the same cards — the coordinator owns
// no app state of its own, only the concurrency bookkeeping below.
export interface PipelineRuntimeView {
  state: MumblerState | null;
  settings: MumblerSettings | null;
  paths: AppPaths | null;
  logger: AppLogger;
}

// Persistence and secrets stay with the runtime: persistState carries the
// normalize-then-notify invariant, and the API key never leaves its resolver.
export interface PipelineHooks {
  persistState(): Promise<void>;
  resolveApiKey(): Promise<string | null>;
}

// A run removed from the coordinator's bookkeeping by cancel. The caller aborts
// and frees it *after* persisting the cancelled card, mirroring the detach →
// persist → abort order that keeps an orphaned pipeline from ever touching a
// replacement's slot.
export interface DetachedRun {
  abortAndRelease(): Promise<void>;
}

// One active (non-detached) pipeline per card: its abort controller plus the
// transcription slot it holds (null for a metadata-only run). Cancel detaches a
// run by removing it here; the detached run keeps its own reference and so can
// only ever release its *own* slot, never a replacement's.
interface ActivePipelineRun {
  controller: AbortController;
  slot: TranscriptionSlot | null;
}

// Owns everything about *running* pipelines — the concurrency slots, the active
// runs, the in-flight promises, and the queued-card drain — while the runtime
// keeps owning the app state the pipelines mutate. The split follows the state:
// these fields are read by nothing outside this class, whereas every card field
// belongs to the runtime's single persist path.
export class PipelineCoordinator {
  private readonly transcriptionSlots = new TranscriptionSlotPool();
  private readonly activeRuns = new Map<string, ActivePipelineRun>();
  // In-flight pipeline promises, so shutdown can await them after aborting.
  private readonly activePipelines = new Set<Promise<void>>();
  private shuttingDown = false;

  constructor(
    private readonly runtime: PipelineRuntimeView,
    private readonly hooks: PipelineHooks,
  ) {}

  assertCardCanStart(card: MumblerCard): void {
    if (isCardBusy(card) || this.activeRuns.has(card.id)) {
      throw new OperationError("This card is already being processed.");
    }
  }

  hasRun(cardId: string): boolean {
    return this.activeRuns.has(cardId);
  }

  // Remove a run from the bookkeeping without aborting it yet. Returns null when
  // the card has no active run (a queued-only cancel, or a run that already
  // settled). The returned handle aborts the pipeline and frees its slot.
  detachRun(cardId: string): DetachedRun | null {
    const run = this.activeRuns.get(cardId);
    if (run === undefined) {
      return null;
    }
    this.activeRuns.delete(cardId);
    return {
      abortAndRelease: async (): Promise<void> => {
        run.controller.abort();
        // Releasing the run's own slot is idempotent and admits any queued cards
        // into the freed capacity. A no-op if the slot was already released (e.g.
        // the card was cancelled during the metadata phase).
        await this.releaseSlotAndDrain(run.slot);
      },
    };
  }

  async startOrEnqueue(
    cardId: string,
    mode: PipelineMode,
    requestedStartStep?: PipelineStartStep,
  ): Promise<void> {
    const state = this.runtime.state!;
    const settings = this.runtime.settings!;
    const card = state.cards.find((entry) => entry.id === cardId);

    if (card === undefined) {
      throw new OperationError("Card to process does not exist.");
    }

    this.assertCardCanStart(card);

    if ((await this.hooks.resolveApiKey()) === null) {
      throw new OperationError("Gemini API key is not configured.");
    }

    const startStep = requestedStartStep ?? "transcription";
    const needsTranscriptionSlot = startStep === "transcription";
    const slotAvailable = this.transcriptionSlots.inUse < settings.concurrencyLimit;

    if (!needsTranscriptionSlot || slotAvailable) {
      const slot = needsTranscriptionSlot ? this.transcriptionSlots.acquire() : null;
      card.status = startStep === "transcription" ? "Transcribing" : "Generating Metadata";
      card.activeStep = startStep;
      card.queuedMode = null;
      card.queuedAtUtc = null;
      card.updatedAtUtc = Date.now();
      await this.hooks.persistState();
      this.spawnCardPipeline(cardId, startStep, mode, slot);
      return;
    }

    card.status = "Queued";
    card.queuedMode = mode;
    card.queuedAtUtc = Date.now();
    card.activeStep = null;
    card.updatedAtUtc = Date.now();
    await this.hooks.persistState();
    await this.runtime.logger.info(
      "pipeline.queued",
      "Queued card; awaiting transcription slot.",
      {
        cardId,
        mode,
        activeSlots: this.transcriptionSlots.inUse,
        concurrencyLimit: settings.concurrencyLimit,
      },
    );
  }

  private spawnCardPipeline(
    cardId: string,
    startStep: PipelineStartStep,
    mode: PipelineMode,
    slot: TranscriptionSlot | null,
  ): void {
    const controller = new AbortController();
    const run: ActivePipelineRun = { controller, slot };
    this.activeRuns.set(cardId, run);

    // Resolve the key just-in-time inside the spawned chain (env-first, then the
    // secrets file), so a key cleared between enqueue and start is caught here and
    // surfaces as a normal pipeline "not configured" error on the card. An empty
    // string is passed when nothing resolves; the pipeline's own guard rejects it.
    const pipeline = (async () => {
      const apiKey = (await this.hooks.resolveApiKey()) ?? "";
      const ctx: CardPipelineContext = {
        state: this.runtime.state!,
        settings: this.runtime.settings!,
        paths: this.runtime.paths!,
        logger: this.runtime.logger,
        signal: controller.signal,
        apiKey,
        persistState: () => this.hooks.persistState(),
        releaseTranscriptionSlot: () => this.releaseSlotAndDrain(slot),
      };
      await executeCardPipeline(cardId, startStep, mode, ctx);
    })()
      .catch(async (error: unknown) => {
        await this.runtime.logger.error(
          "pipeline.unhandled",
          "Unhandled pipeline error.",
          error,
          { cardId, mode, startStep },
        );
      })
      .finally(() => {
        void this.finalizeCardPipeline(cardId, run);
      });

    // Track the chain so shutdown() can await it after aborting.
    this.activePipelines.add(pipeline);
    void pipeline.finally(() => {
      this.activePipelines.delete(pipeline);
    });
  }

  // Frees one transcription slot (if still held) and admits any queued cards into
  // the freed capacity. Idempotent on the slot, so every release path — mid-run
  // after transcription, the pipeline's finally, finalize, and cancel — can call
  // it freely without double-counting.
  private async releaseSlotAndDrain(slot: TranscriptionSlot | null): Promise<void> {
    if (slot === null || !slot.held) {
      return;
    }
    slot.release();
    await this.drainQueued();
  }

  private async finalizeCardPipeline(cardId: string, run: ActivePipelineRun): Promise<void> {
    try {
      // Only the still-current run for this card may touch shared bookkeeping. A
      // run detached by cancel was replaced (or removed) in activeRuns, so this
      // identity check stops an orphaned pipeline from clobbering its replacement;
      // the orphan's own slot was already freed on its release path.
      if (this.activeRuns.get(cardId) !== run) {
        return;
      }
      this.activeRuns.delete(cardId);
      await this.releaseSlotAndDrain(run.slot);
    } catch (error: unknown) {
      await this.runtime.logger.error(
        "pipeline.finalize-failed",
        "Failed to finalize card pipeline state.",
        error,
        { cardId },
      );
    }
  }

  async drainQueued(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    if (this.runtime.state === null || this.runtime.settings === null) {
      return;
    }

    const settings = this.runtime.settings;
    const state = this.runtime.state;

    // Cards with an active run are excluded from selection: spawnCardPipeline
    // registers the run synchronously, but a card's status flips to "Transcribing"
    // only later inside the pipeline. Without this, one drain pass with capacity
    // for several cards would re-select — and double-spawn — the card it just
    // started. We seed the set from active runs and extend it in lockstep as we
    // spawn, rather than rebuilding it from activeRuns on every iteration.
    const excludedCardIds = new Set(this.activeRuns.keys());
    while (this.transcriptionSlots.inUse < settings.concurrencyLimit) {
      const next = selectNextQueuedCard(state.cards, excludedCardIds);

      if (next === null || next.queuedMode === null) {
        return;
      }

      const slot = this.transcriptionSlots.acquire();
      this.spawnCardPipeline(next.id, "transcription", next.queuedMode, slot);
      excludedCardIds.add(next.id);
    }
  }

  // Stop admitting queued cards, abort every in-flight pipeline, and wait for
  // them to unwind. The runtime's shutdown wraps this (once) and then flushes
  // the stores, so the canonical files are current before the process exits.
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const run of this.activeRuns.values()) {
      run.controller.abort();
    }
    await Promise.allSettled([...this.activePipelines]);
  }
}
