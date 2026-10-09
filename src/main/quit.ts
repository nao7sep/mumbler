import type { Translator } from "@shared/i18n/translate";

import type { QuitSaveFailure } from "./core/app-runtime";
import type { PlainDialog } from "./plain-dialog";

// Every quit path in one place (unsaved-edits conventions, Quitting). The menu
// Quit, Cmd+Q, the Dock's Quit and closing the main window on Windows are the
// user's; an OS logout, restart or shutdown is a session end. Both save the
// same work. A user's quit whose save fails is held, and the user chooses
// Retry, Quit anyway or Cancel; a session end never asks, and exits within the
// budget below, under the 5 s Windows gives a session-end message before it
// lets the user end the app.

/** Who started a quit. */
export type QuitOrigin = "user" | "session-end";

/** What the user chose after a failed save; "cancel" is also the dialog closed. */
export type QuitChoice = "retry" | "quit-anyway" | "cancel";

/** What could not be saved: the stores named, or a save that did not finish in time. */
export type QuitFailure = readonly (QuitSaveFailure | "edits")[] | "stalled";

export interface QuitSteps {
  /** A user's quit first: when the window holds session-only drafts, asks
   * whether to discard them; resolves false when the user keeps them. */
  confirmDiscardDrafts(): Promise<boolean>;
  /** Asks the main window to send the edits it has not sent yet. */
  flushEdits(signal: AbortSignal): Promise<void>;
  /** Saves the user's own work; resolves with what could not be saved. */
  save(): Promise<QuitSaveFailure[]>;
  /** The user cancelled the quit: the app takes work again. */
  resume(): Promise<void>;
  /** Closes the backup history and the records. */
  close(details: Record<string, unknown>): Promise<void>;
  /** Shows what failed and waits for the user's choice. */
  ask(failure: QuitFailure): Promise<QuitChoice>;
  /** Closes an open question as if cancelled, for a session end. */
  dismissQuestion(): void;
  /** Logs a quit step that failed or ran out of time. */
  warn(event: string, message: string, details: Record<string, unknown>): void;
  /** Ends the process. */
  exit(): void;
}

/** Each step's bound, in ms. A user's quit waits at most 15 s before it asks
 * or exits; a session end at most 4 s in all. */
export const QUIT_BUDGETS: Record<QuitOrigin, { flush: number; save: number; close: number }> = {
  user: { flush: 1_000, save: 9_000, close: 5_000 },
  "session-end": { flush: 500, save: 2_000, close: 1_500 },
};

/** A session end that arrives while a quit's step runs ends the process this
 * long after it arrived, whatever that step is doing. */
export const SESSION_END_LIMIT_MS = 4_500;

type Bounded<T> = { done: true; value: T } | { done: false };

/** Waits for `work` at most `ms`; a rejection counts as not done. */
export function within<T>(work: Promise<T>, ms: number): Promise<Bounded<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<Bounded<T>>((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), ms);
  });
  const finished = work.then(
    (value): Bounded<T> => ({ done: true, value }),
    // A step that throws is logged by the caller as not done.
    (): Bounded<T> => ({ done: false }),
  );
  return Promise.race([finished, expired]).finally(() => clearTimeout(timer));
}

export interface QuitController {
  /** Starts a quit, or holds one that arrives while a quit runs; a session end
   * that arrives then turns the running quit into a session end. */
  request(origin: QuitOrigin): void;
  isRunning(): boolean;
}

export function createQuitController(steps: QuitSteps): QuitController {
  let running = false;
  let sessionEnding = false;
  let exited = false;

  const exit = (): void => {
    if (exited) return;
    exited = true;
    steps.exit();
  };

  const budget = () => QUIT_BUDGETS[sessionEnding ? "session-end" : "user"];

  async function finish(details: Record<string, unknown>): Promise<void> {
    const closed = await within(steps.close(details), budget().close);
    if (!closed.done) {
      steps.warn("quit.close-incomplete", "The backup history or the records did not close in time.", {
        boundMs: budget().close,
      });
    }
    exit();
  }

  async function run(): Promise<void> {
    // Session-only drafts are not quit-time saves: a user's quit asks before it
    // discards them, and a session end never asks (unsaved-edits-conventions).
    if (!sessionEnding) {
      let proceed: boolean;
      try {
        proceed = await steps.confirmDiscardDrafts();
      } catch (error: unknown) {
        steps.warn("quit.drafts-question-failed", "The unsaved-changes question could not be shown; cancelling the quit.", {
          error: error instanceof Error ? error.message : String(error),
        });
        proceed = false;
      }
      // A session end that closed the question goes on without asking.
      if (!proceed && !sessionEnding) {
        running = false;
        return;
      }
    }
    for (;;) {
      const flush = new AbortController();
      const flushed = await within(Promise.resolve().then(() => steps.flushEdits(flush.signal)), budget().flush);
      flush.abort();
      if (!flushed.done) {
        steps.warn("quit.flush-incomplete", "The window did not send its unsent edits in time.", {
          boundMs: budget().flush,
        });
      }
      const saved = await within(steps.save(), budget().save);
      const unsaved = saved.done ? [...saved.value, ...(!flushed.done ? ["edits" as const] : [])] : [];
      const failure: QuitFailure | null = !saved.done ? "stalled" : unsaved.length > 0 ? unsaved : null;
      if (failure === "stalled") {
        steps.warn("quit.save-incomplete", "Saving before quitting did not finish in time.", {
          boundMs: budget().save,
        });
      }
      if (failure === null) {
        return finish({ origin: sessionEnding ? "session-end" : "user" });
      }
      if (sessionEnding) {
        return finish({ origin: "session-end", unsaved: failure });
      }
      let choice: QuitChoice;
      try {
        choice = await steps.ask(failure);
      } catch (error: unknown) {
        steps.warn("quit.question-failed", "The quit question could not be shown; cancelling the quit.", {
          error: error instanceof Error ? error.message : String(error),
        });
        choice = "cancel";
      }
      // A session end closed the question: save once more within its budget.
      if (sessionEnding || choice === "retry") continue;
      if (choice === "quit-anyway") {
        steps.warn("quit.forced", "Quit anyway, without what could not be saved.", { unsaved: failure });
        return finish({ origin: "user", unsaved: failure, forced: true });
      }
      running = false;
      await steps.resume().catch((error: unknown) => {
        steps.warn("quit.resume-failed", "Queued recordings could not be started again after a cancelled quit.", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }
  }

  return {
    isRunning: () => running,
    request(origin) {
      if (exited) return;
      if (origin === "session-end" && !sessionEnding) {
        sessionEnding = true;
        if (running) {
          steps.dismissQuestion();
          setTimeout(() => {
            steps.warn("quit.session-end-limit", "The session ended before the quit finished; exiting.", {
              limitMs: SESSION_END_LIMIT_MS,
            });
            exit();
          }, SESSION_END_LIMIT_MS);
        }
      }
      if (running) return;
      running = true;
      void run().catch((error: unknown) => {
        steps.warn("quit.failed", "The quit failed.", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (sessionEnding) exit();
        else {
          running = false;
          void steps.resume().catch((resumeError: unknown) => steps.warn("quit.resume-failed", "Could not resume after the failed quit.", { error: String(resumeError) }));
        }
      });
    },
  };
}

const FAILURE_NAMES = {
  queue: "quit.queue",
  transcripts: "quit.transcripts",
  settings: "quit.settings",
  edits: "quit.edits",
} as const satisfies Record<QuitSaveFailure | "edits", string>;

const DISCARD_DRAFT_BODIES = {
  quit: "quit.discardSettingsBody",
  close: "windowClose.discardSettingsBody",
} as const;

/** Asked before a user's quit or window close discards a session-only draft:
 * Keep editing, the default, keeps it; Discard goes on without saving it. */
export function discardDraftsDialog(translator: Translator, action: "quit" | "close"): PlainDialog<"discard" | "cancel"> {
  return {
    language: translator.language,
    title: translator.t("decision.discardTitle"),
    bodyLabel: translator.t("quit.detailsLabel"),
    body: translator.t(DISCARD_DRAFT_BODIES[action]),
    actions: [
      { choice: "cancel", label: translator.t("decision.keepEditing") },
      { choice: "discard", label: translator.t("decision.discard"), tone: "danger" },
    ],
    focus: "cancel",
    dismiss: "cancel",
  };
}

/** The question a failed save asks: Cancel keeps the app running, Retry saves
 * again, and Quit anyway, the destructive choice, is last and never focused. */
export function quitFailureDialog(translator: Translator, failure: QuitFailure): PlainDialog<QuitChoice> {
  return {
    language: translator.language,
    title: translator.t("quit.title"),
    bodyLabel: translator.t("quit.detailsLabel"),
    body: failure === "stalled"
      ? translator.t("quit.stalledBody")
      // Joined as running prose ("the queue and the settings"), not as a list of names.
      : translator.t("quit.body", {
        items: new Intl.ListFormat(translator.language, { type: "conjunction", style: "long" })
          .format(failure.map((store) => translator.t(FAILURE_NAMES[store]))),
      }),
    detail: translator.t("quit.detail"),
    actions: [
      { choice: "cancel", label: translator.t("common.cancel") },
      { choice: "retry", label: translator.t("common.retry"), tone: "primary" },
      { choice: "quit-anyway", label: translator.t("quit.quitAnyway"), tone: "danger" },
    ],
    focus: "retry",
    dismiss: "cancel",
  };
}
