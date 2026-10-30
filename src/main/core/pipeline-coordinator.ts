import {
  type AppPaths,
  type MumblerCard,
  type MumblerSettings,
  type MumblerQueue,
} from "@shared/app-shell";
import { isCardBusy } from "@shared/card-status";

import { CancelledError } from "./cancellation";
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
// passes its own live state bag, so the coordinator and the runtime see the same
// cards; the coordinator owns only the runs and their places.
export interface PipelineRuntimeView {
  state: MumblerQueue | null;
  settings: MumblerSettings | null;
  paths: AppPaths | null;
  logger: AppLogger;
}

// The runtime owns the queue, its persistence and secret resolution.
export interface PipelineHooks {
  /** Writes the given cards' files; called inside a queue command. */
  persistCards(cards: readonly MumblerCard[]): Promise<void>;
  resolveApiKey(): Promise<string | null>;
  /** Runs `work` as a queue command, after every earlier one. */
  command<T>(work: () => Promise<T>): Promise<T>;
}

// One active (non-detached) run per card: its abort controller and the place it
// holds under Concurrent transcriptions. Cancel detaches a run by removing it
// here; the detached run keeps its own reference and so only ever frees its own
// place.
interface ActivePipelineRun {
  controller: AbortController;
  slot: TranscriptionSlot;
  // Provider work the run started that may go on after it was cancelled.
  work: Set<Promise<unknown>>;
  done: Promise<void>;
}

// Schedules card runs into the user's Concurrent transcriptions width. A run
// holds its place from its first step to its slug: every request it sends
// Gemini counts against the setting (developer decision). Gemini does the
// work while the Mac waits, minutes per recording for a transcription, so the
// remote steps run side by side up to that width. Its methods other than
// hasRun run inside the runtime's queue commands; runs report back through
// commands of their own.
export class PipelineCoordinator {
  private readonly slots = new TranscriptionSlotPool();
  private readonly activeRuns = new Map<string, ActivePipelineRun>();
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

  // Takes the card away from its run and aborts it, so no result the run
  // receives afterwards can reach the card. The run keeps its place until its
  // physical work settles: an upload the provider SDK cannot abort goes on after
  // Cancel, and freeing its place early would let more real uploads run than the
  // setting allows.
  detachAndAbort(cardId: string): boolean {
    const run = this.activeRuns.get(cardId);
    if (run === undefined) {
      return false;
    }
    this.activeRuns.delete(cardId);
    run.controller.abort();
    return true;
  }

  // Sets the card Queued, or running when a place is free, and saves that
  // before the run exists; a failed save puts the card back as it was.
  async startOrEnqueue(
    cardId: string,
    mode: PipelineMode,
    requestedStartStep?: PipelineStartStep,
  ): Promise<void> {
    if (this.shuttingDown) throw new OperationError("Mumbler is closing; new processing cannot start.");
    const settings = this.runtime.settings!;
    const card = this.runtime.state!.cards.find((entry) => entry.id === cardId);
    if (card === undefined) {
      throw new OperationError("Card to process does not exist.");
    }
    this.assertCardCanStart(card);

    const startStep = requestedStartStep ?? "transcription";
    const queued = this.slots.inUse >= settings.concurrencyLimit;
    const previous = {
      status: card.status,
      activeStep: card.activeStep,
      queuedMode: card.queuedMode,
      queuedAtUtc: card.queuedAtUtc,
    };
    // A queued card keeps the step it starts from in activeStep.
    card.status = queued ? "Queued" : runningStatus(startStep);
    card.activeStep = startStep;
    card.queuedMode = queued ? mode : null;
    card.queuedAtUtc = queued ? Date.now() : null;
    try {
      await this.hooks.persistCards([card]);
    } catch (error: unknown) {
      Object.assign(card, previous);
      throw error;
    }
    if (!queued) {
      this.spawnCardPipeline(cardId, startStep, mode, this.slots.acquire());
      return;
    }
    await this.runtime.logger.info(
      "pipeline.queued", "Queued card; awaiting a free place.",
      { cardId, mode, activeSlots: this.slots.inUse, concurrencyLimit: settings.concurrencyLimit },
    );
  }

  // Starts queued cards, earliest first, into free places, saving their new
  // status before their runs start; a failed save leaves them queued.
  async drainQueued(): Promise<void> {
    if (this.shuttingDown || this.runtime.state === null || this.runtime.settings === null) {
      return;
    }
    const limit = this.runtime.settings.concurrencyLimit;
    const starting: { card: MumblerCard; step: PipelineStartStep; mode: PipelineMode; queuedAtUtc: number | null }[] = [];
    while (this.slots.inUse + starting.length < limit) {
      const next = selectNextQueuedCard(this.runtime.state.cards);
      if (next === null || next.queuedMode === null) break;
      const step = next.activeStep ?? "transcription";
      starting.push({ card: next, step, mode: next.queuedMode, queuedAtUtc: next.queuedAtUtc });
      next.status = runningStatus(step);
      next.activeStep = step;
      next.queuedMode = null;
      next.queuedAtUtc = null;
    }
    if (starting.length === 0) return;
    try {
      await this.hooks.persistCards(starting.map(({ card }) => card));
    } catch (error: unknown) {
      for (const { card, mode, queuedAtUtc } of starting) {
        card.status = "Queued";
        card.queuedMode = mode;
        card.queuedAtUtc = queuedAtUtc;
      }
      await this.runtime.logger.error("pipeline.drain-failed", "Queued cards could not be started; they stay queued.", error);
      return;
    }
    for (const { card, step, mode } of starting) {
      this.spawnCardPipeline(card.id, step, mode, this.slots.acquire());
    }
  }

  private spawnCardPipeline(
    cardId: string,
    startStep: PipelineStartStep,
    mode: PipelineMode,
    slot: TranscriptionSlot,
  ): void {
    const controller = new AbortController();
    const run: ActivePipelineRun = { controller, slot, work: new Set(), done: Promise.resolve() };
    this.activeRuns.set(cardId, run);
    const ownsCard = (): boolean => this.activeRuns.get(cardId) === run;
    const card = (): MumblerCard | undefined => this.runtime.state!.cards.find((entry) => entry.id === cardId);

    run.done = (async () => {
      // Resolved just in time, so a key cleared after the card was queued
      // surfaces as the pipeline's own "not configured" error on the card.
      const apiKey = (await this.hooks.resolveApiKey()) ?? "";
      const ctx: CardPipelineContext = {
        settings: this.runtime.settings!,
        paths: this.runtime.paths!,
        logger: this.runtime.logger,
        signal: controller.signal,
        apiKey,
        current: () => {
          const current = card();
          if (current === undefined || !ownsCard() || controller.signal.aborted) throw new CancelledError();
          return current;
        },
        update: (change) => this.hooks.command(async () => {
          const current = card();
          if (current === undefined || !ownsCard() || controller.signal.aborted) throw new CancelledError();
          change(current);
          await this.hooks.persistCards([current]);
        }),
        settle: (change) => this.hooks.command(async () => {
          const current = card();
          if (current === undefined || !ownsCard()) return;
          change(current);
          await this.hooks.persistCards([current]);
        }),
        trackWork: (work) => {
          run.work.add(work);
          const settled = (): void => { run.work.delete(work); };
          work.then(settled, settled);
        },
      };
      await executeCardPipeline(cardId, startStep, mode, ctx);
    })()
      .catch(async (error: unknown) => {
        await this.runtime.logger.error("pipeline.unhandled", "Unhandled pipeline error.", error, { cardId, mode, startStep });
      })
      .finally(() => {
        if (ownsCard()) this.activeRuns.delete(cardId);
        // The place is freed once the provider work the run started settles.
        void Promise.allSettled([...run.work])
          .then(() => {
            run.slot.release();
            return this.hooks.command(() => this.drainQueued());
          })
          .catch((error: unknown) => this.runtime.logger.error("pipeline.finalize-failed", "Failed to start queued cards after a run.", error, { cardId }));
      });
  }

  // At quit, inside a queue command: admits nothing more and aborts every run.
  // The returned promise settles once they have unwound; the caller awaits it
  // outside the command, since runs report through commands as they unwind.
  stop(): { settled: Promise<unknown> } {
    this.shuttingDown = true;
    const runs = [...this.activeRuns.values()];
    for (const run of runs) run.controller.abort();
    return { settled: Promise.allSettled(runs.map((run) => run.done)) };
  }

  // A quit the user cancelled: admit queued cards again.
  async resume(): Promise<void> {
    this.shuttingDown = false;
    await this.drainQueued();
  }
}

function runningStatus(step: PipelineStartStep): Extract<MumblerCard["status"], "Transcribing" | "Generating Metadata"> {
  return step === "transcription" ? "Transcribing" : "Generating Metadata";
}
