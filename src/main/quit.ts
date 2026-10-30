import type { Translator } from "@shared/i18n/translate";

import type { QuitSaveFailure, RunningWork } from "./core/app-runtime";
import type { PlainDialog } from "./plain-dialog";

// Every quit path in one place (unsaved-edits conventions, Quitting). The menu
// Quit, Cmd+Q, the Dock's Quit and closing the main window are the user's; an
// OS logout, restart or shutdown is a session end. Both save the same work. A
// user's quit whose save fails, or is still running at the deadline, is held,
// and the user chooses Retry, Quit anyway or Cancel; a session end never asks.
// One exit deadline, fixed when the quit begins, bounds every step; an answered
// question starts it again (architecture-conventions, Deadlines at the owner).

/** Who started a quit. */
export type QuitOrigin = "user" | "session-end";

/** What the user chose after a failed save; "cancel" is also the dialog closed. */
export type QuitChoice = "retry" | "quit-anyway" | "cancel";

/** What prevented quit: failed stores, a save not finished by the deadline, or drafts that could not be checked. */
export type QuitFailure = readonly (QuitSaveFailure | "edits")[] | "stalled" | "drafts-unavailable";

export interface QuitSteps {
  /** A user's quit first: when app-owned work is still running, asks whether
   * to stop it; resolves false when the user keeps it running. */
  confirmStopWork(): Promise<boolean>;
  /** Then, when the window holds session-only drafts, asks whether to discard
   * them; resolves false when the user keeps them. */
  confirmDiscardDrafts(): Promise<boolean>;
  /** Asks the main window to send the edits it has not sent yet; the signal
   * ends at the exit deadline. */
  flushEdits(deadline: AbortSignal): Promise<void>;
  /** Saves the user's own work; resolves with what could not be saved. A call
   * while one runs joins it. */
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
  /** Ends the process: cleanly when every step settled, otherwise at once,
   * since a clean exit waits for a worker still inside a native call. */
  exit(settled: boolean): void;
}

/** The one exit deadline, in ms: a user's quit, restarted by each answered
 * question, and an OS session end from its takeover, under the 5 s Windows
 * gives a session-end message before it lets the user end the app. */
export const QUIT_DEADLINE_MS: Record<QuitOrigin, number> = { user: 5_000, "session-end": 4_000 };

type Bounded<T> = { done: true; value: T } | { done: false };

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
  let deadline = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const exit = (settled: boolean): void => {
    if (exited) return;
    exited = true;
    clearTimeout(timer);
    steps.exit(settled);
  };

  // A fresh deadline. At a session end's deadline the process ends whatever
  // step runs; a user's deadline ends the step waiting on it.
  const startDeadline = (origin: QuitOrigin): void => {
    clearTimeout(timer);
    deadline = new AbortController();
    const current = deadline;
    timer = setTimeout(() => {
      current.abort();
      if (origin === "session-end") {
        steps.warn("quit.deadline", "The session ended before the quit finished; exiting.", { deadlineMs: QUIT_DEADLINE_MS[origin] });
        exit(false);
      }
    }, QUIT_DEADLINE_MS[origin]);
  };

  // Waits for `work` until the current deadline; a rejection counts as not done.
  function untilDeadline<T>(work: Promise<T>): Promise<Bounded<T>> {
    const signal = deadline.signal;
    return new Promise<Bounded<T>>((resolve) => {
      const expired = (): void => resolve({ done: false });
      if (signal.aborted) expired();
      else signal.addEventListener("abort", expired, { once: true });
      work.then(
        (value) => { signal.removeEventListener("abort", expired); resolve({ done: true, value }); },
        // A step that throws is logged by the caller as not done.
        () => { signal.removeEventListener("abort", expired); resolve({ done: false }); },
      );
    });
  }

  async function finish(details: Record<string, unknown>): Promise<void> {
    const closed = await untilDeadline(steps.close(details));
    if (!closed.done) {
      steps.warn("quit.close-incomplete", "The backup history or the records did not close before the deadline.", {});
    }
    exit(closed.done);
  }

  // A question a user's quit asks before it ends anything; false cancels the
  // quit. A session end never asks, and one that closed the question goes on.
  async function asked(question: () => Promise<boolean>, event: string, what: string): Promise<boolean> {
    if (sessionEnding) return true;
    let proceed: boolean;
    try {
      proceed = await question();
    } catch (error: unknown) {
      steps.warn(event, `The ${what} question could not be shown; cancelling the quit.`, {
        error: error instanceof Error ? error.message : String(error),
      });
      proceed = false;
    }
    return proceed || sessionEnding;
  }

  async function run(): Promise<void> {
    // Running app-owned work is asked about before quit stops it, and
    // session-only drafts, which are not quit-time saves, before quit discards
    // them (unsaved-edits-conventions, Closing and quitting).
    if (!(await asked(steps.confirmStopWork, "quit.work-question-failed", "running-work"))
      || !(await asked(steps.confirmDiscardDrafts, "quit.drafts-question-failed", "unsaved-changes"))) {
      running = false;
      return;
    }
    if (!sessionEnding) startDeadline("user");
    for (;;) {
      const flushed = await untilDeadline(Promise.resolve().then(() => steps.flushEdits(deadline.signal)));
      if (!flushed.done) {
        steps.warn("quit.flush-incomplete", "The window did not send its unsent edits.", {});
      }
      const saved = await untilDeadline(steps.save());
      const unsaved = saved.done ? [...saved.value, ...(!flushed.done ? ["edits" as const] : [])] : [];
      const failure: QuitFailure | null = !saved.done ? "stalled" : unsaved.length > 0 ? unsaved : null;
      if (failure === "stalled") {
        steps.warn("quit.save-incomplete", "Saving before quitting did not finish before the deadline.", {});
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
      // A session end closed the question: save once more within its deadline.
      if (sessionEnding) continue;
      if (choice === "retry") {
        startDeadline("user");
        continue;
      }
      if (choice === "quit-anyway") {
        steps.warn("quit.forced", "Quit anyway, without what could not be saved.", { unsaved: failure });
        startDeadline("user");
        return finish({ origin: "user", unsaved: failure, forced: true });
      }
      clearTimeout(timer);
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
        startDeadline("session-end");
        if (running) steps.dismissQuestion();
      }
      if (running) return;
      running = true;
      void run().catch((error: unknown) => {
        steps.warn("quit.failed", "The quit failed.", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (sessionEnding) exit(false);
        else {
          clearTimeout(timer);
          running = false;
          void steps.resume().catch((resumeError: unknown) => steps.warn("quit.resume-failed", "Could not resume after the failed quit.", { error: String(resumeError) }));
        }
      });
    },
  };
}

const FAILURE_NAMES = {
  queue: "quit.queue",
  settings: "quit.settings",
  edits: "quit.edits",
} as const satisfies Record<QuitSaveFailure | "edits", string>;

/** Asked before a user's quit stops app-owned work still running, or null when
 * none runs: Keep working, the default, cancels the quit; Stop and quit goes on. */
export function stopWorkDialog(translator: Translator, work: RunningWork): PlainDialog<"quit" | "cancel"> | null {
  const sentences = [
    ...(work.recordings > 0 ? [translator.t("quit.workRecordings", { count: work.recordings })] : []),
    ...(work.tools > 0 ? [translator.t("quit.workTools", { count: work.tools })] : []),
  ];
  if (sentences.length === 0) return null;
  return {
    language: translator.language,
    title: translator.t("quit.workTitle"),
    bodyLabel: translator.t("quit.detailsLabel"),
    // Joined as the language joins sentences.
    body: sentences.length === 2 ? translator.t("common.sentences", { first: sentences[0]!, rest: sentences[1]! }) : sentences[0]!,
    actions: [
      { choice: "cancel", label: translator.t("quit.keepWorking") },
      { choice: "quit", label: translator.t("quit.stopAndQuit"), tone: "danger" },
    ],
    focus: "cancel",
    dismiss: "cancel",
  };
}

/** Asked before a user's quit discards a session-only draft: Keep editing, the
 * default, keeps it; Discard goes on without saving it. */
export function discardDraftsDialog(translator: Translator): PlainDialog<"discard" | "cancel"> {
  return {
    language: translator.language,
    title: translator.t("decision.discardTitle"),
    bodyLabel: translator.t("quit.detailsLabel"),
    body: translator.t("quit.discardSettingsBody"),
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
    body: failure === "drafts-unavailable"
      ? translator.t("quit.draftsUnavailableBody")
      : failure === "stalled"
      ? translator.t("quit.stalledBody")
      // Joined as running prose ("the queue and the settings"), not as a list of names.
      : translator.t("quit.body", {
        items: new Intl.ListFormat(translator.language, { type: "conjunction", style: "long" })
          .format(failure.map((store) => translator.t(FAILURE_NAMES[store]))),
      }),
    detail: translator.t("quit.detail"),
    // A window that did not report its drafts is unlikely to answer a retry.
    actions: failure === "drafts-unavailable"
      ? [
        { choice: "cancel", label: translator.t("common.cancel") },
        { choice: "quit-anyway", label: translator.t("quit.quitAnyway"), tone: "danger" },
      ]
      : [
        { choice: "cancel", label: translator.t("common.cancel") },
        { choice: "retry", label: translator.t("common.retry"), tone: "primary" },
        { choice: "quit-anyway", label: translator.t("quit.quitAnyway"), tone: "danger" },
      ],
    focus: failure === "drafts-unavailable" ? "cancel" : "retry",
    dismiss: "cancel",
  };
}
