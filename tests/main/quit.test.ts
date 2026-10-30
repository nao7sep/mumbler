import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { QuitSaveFailure } from "@main/core/app-runtime";
import { createQuitController, discardDraftsDialog, quitFailureDialog, stopWorkDialog, type QuitChoice, type QuitFailure, type QuitSteps } from "@main/quit";
import { loadCatalogue } from "@shared/i18n/catalogues";
import { createTranslator } from "@shared/i18n/translate";

vi.mock("electron", () => ({}));

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

interface Harness {
  steps: QuitSteps;
  calls: string[];
  asked: QuitFailure[];
  exits: () => number;
  answer: (choice: QuitChoice) => void;
}

/** Steps that record what the quit did; each can be replaced per case. */
function harness(overrides: Partial<QuitSteps> = {}): Harness {
  const calls: string[] = [];
  const asked: QuitFailure[] = [];
  let exits = 0;
  let answer: (choice: QuitChoice) => void = () => undefined;
  const steps: QuitSteps = {
    confirmStopWork: async () => true,
    confirmDiscardDrafts: async () => true,
    flushEdits: async () => { calls.push("flush"); },
    save: async () => { calls.push("save"); return []; },
    resume: async () => { calls.push("resume"); },
    close: async () => { calls.push("close"); },
    ask: (failure) => {
      calls.push("ask");
      asked.push(failure);
      return new Promise<QuitChoice>((resolve) => { answer = resolve; });
    },
    dismissQuestion: () => { calls.push("dismiss"); answer("cancel"); },
    warn: (event) => { calls.push(`warn:${event}`); },
    exit: (settled) => { exits += 1; calls.push(settled ? "exit" : "kill"); },
    ...overrides,
  };
  return { steps, calls, asked, exits: () => exits, answer: (choice) => answer(choice) };
}

/** A save that fails with `failures` the first `times` calls, then succeeds. */
function failingSave(failures: QuitSaveFailure[], times: number, calls: string[]): () => Promise<QuitSaveFailure[]> {
  let count = 0;
  return async () => {
    calls.push("save");
    count += 1;
    return count <= times ? failures : [];
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a quit the user started", () => {
  it("sends the window's edits, saves, closes and exits, in that order", async () => {
    const quit = harness();
    createQuitController(quit.steps).request("user");
    await vi.advanceTimersByTimeAsync(0);

    expect(quit.calls).toEqual(["flush", "save", "close", "exit"]);
  });

  it("asks about pending edits even when the required stores saved", async () => {
    const quit = harness({ flushEdits: async () => { throw new Error("draft save failed"); } });
    createQuitController(quit.steps).request("user");
    await vi.advanceTimersByTimeAsync(0);
    expect(quit.asked).toEqual([["edits"]]);
    expect(quit.exits()).toBe(0);
    quit.answer("cancel");
    await vi.advanceTimersByTimeAsync(0);
    expect(quit.calls).toContain("resume");
  });

  it("a failed question cancels quit and permits a later successful attempt", async () => {
    const quit = harness({ ask: async () => { throw new Error("dialog failed"); } });
    quit.steps.save = failingSave(["queue"], 1, quit.calls);
    const controller = createQuitController(quit.steps);
    controller.request("user");
    await vi.advanceTimersByTimeAsync(0);
    expect(quit.exits()).toBe(0);
    expect(quit.calls).toContain("resume");
    controller.request("user");
    await vi.advanceTimersByTimeAsync(0);
    expect(quit.exits()).toBe(1);
  });

  it("holds a quit that arrives while one runs, and exits once", async () => {
    let finishSave!: (failures: QuitSaveFailure[]) => void;
    const quit = harness();
    quit.steps.save = () => {
      quit.calls.push("save");
      return new Promise((resolve) => { finishSave = resolve; });
    };
    const controller = createQuitController(quit.steps);

    controller.request("user");
    controller.request("user");
    await vi.advanceTimersByTimeAsync(0);
    finishSave([]);
    await vi.advanceTimersByTimeAsync(0);
    controller.request("user");
    await vi.advanceTimersByTimeAsync(0);

    expect(quit.calls.filter((call) => call === "save")).toHaveLength(1);
    expect(quit.exits()).toBe(1);
  });

  it("asks Retry or Quit anyway when the save fails, and saves again on Retry", async () => {
    const quit = harness();
    quit.steps.save = failingSave(["queue", "settings"], 1, quit.calls);
    createQuitController(quit.steps).request("user");
    await vi.advanceTimersByTimeAsync(0);

    expect(quit.asked).toEqual([["queue", "settings"]]);
    expect(quit.exits()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(quit.exits(), "the question waits for the user, not the clock").toBe(0);

    quit.answer("retry");
    await vi.advanceTimersByTimeAsync(0);

    expect(quit.calls).toEqual(["flush", "save", "ask", "flush", "save", "close", "exit"]);
  });

  it("exits without what failed on Quit anyway, and logs that it did", async () => {
    const quit = harness();
    quit.steps.save = failingSave(["queue"], Infinity, quit.calls);
    createQuitController(quit.steps).request("user");
    await vi.advanceTimersByTimeAsync(0);

    quit.answer("quit-anyway");
    await vi.advanceTimersByTimeAsync(0);

    expect(quit.calls).toEqual(["flush", "save", "ask", "warn:quit.forced", "close", "exit"]);
  });

  it("keeps running on Cancel, and a later quit starts over", async () => {
    const quit = harness();
    quit.steps.save = failingSave(["queue"], 1, quit.calls);
    const controller = createQuitController(quit.steps);
    controller.request("user");
    await vi.advanceTimersByTimeAsync(0);

    quit.answer("cancel");
    await vi.advanceTimersByTimeAsync(0);
    expect(quit.calls).toEqual(["flush", "save", "ask", "resume"]);
    expect(quit.exits()).toBe(0);

    controller.request("user");
    await vi.advanceTimersByTimeAsync(0);
    expect(quit.calls.slice(4)).toEqual(["flush", "save", "close", "exit"]);
  });

  it("asks about a save still running at the 5 s deadline, and Retry waits for it under a fresh one", async () => {
    let finishSave!: (failures: QuitSaveFailure[]) => void;
    const running = new Promise<QuitSaveFailure[]>((resolve) => { finishSave = resolve; });
    const quit = harness({ save: () => { quit.calls.push("save"); return running; } });
    createQuitController(quit.steps).request("user");

    await vi.advanceTimersByTimeAsync(4_999);
    expect(quit.asked).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(quit.asked).toEqual(["stalled"]);
    expect(quit.calls).toContain("warn:quit.save-incomplete");

    quit.answer("retry");
    await vi.advanceTimersByTimeAsync(4_000);
    finishSave([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(quit.calls.slice(-2)).toEqual(["close", "exit"]);
  });

  it("starts the deadline only once the questions are answered", async () => {
    let proceed!: (value: boolean) => void;
    const quit = harness({
      confirmStopWork: () => new Promise<boolean>((resolve) => { proceed = resolve; }),
      save: never,
    });
    createQuitController(quit.steps).request("user");
    await vi.advanceTimersByTimeAsync(60_000);
    proceed(true);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(quit.asked).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(quit.asked).toEqual(["stalled"]);
  });

  it("kills the process when the close has not finished by the deadline", async () => {
    const quit = harness({ close: never });
    createQuitController(quit.steps).request("user");

    await vi.advanceTimersByTimeAsync(4_999);
    expect(quit.exits()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(quit.calls.slice(-2)).toEqual(["warn:quit.close-incomplete", "kill"]);
  });
});

describe("unsaved Settings changes at a user's quit", () => {
  function asking(): { quit: Harness; answer: (proceed: boolean) => void; asked: () => number } {
    let answer: (proceed: boolean) => void = () => undefined;
    let asked = 0;
    const quit = harness({
      confirmDiscardDrafts: () => {
        asked += 1;
        return new Promise<boolean>((resolve) => { answer = resolve; });
      },
    });
    return { quit, answer: (proceed) => answer(proceed), asked: () => asked };
  }

  it("asks first and goes no further while the question is open", async () => {
    const drafts = asking();
    const controller = createQuitController(drafts.quit.steps);
    controller.request("user");
    controller.request("user");
    await vi.advanceTimersByTimeAsync(0);
    expect(drafts.asked()).toBe(1);
    expect(drafts.quit.calls).toEqual([]);
    drafts.answer(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(drafts.quit.calls).toEqual(["flush", "save", "close", "exit"]);
  });

  it("keeps running with nothing saved or resumed when the user keeps the changes, and asks again next time", async () => {
    const drafts = asking();
    const controller = createQuitController(drafts.quit.steps);
    controller.request("user");
    await vi.advanceTimersByTimeAsync(0);
    drafts.answer(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(drafts.quit.calls).toEqual([]);
    expect(controller.isRunning()).toBe(false);
    controller.request("user");
    await vi.advanceTimersByTimeAsync(0);
    expect(drafts.asked()).toBe(2);
  });

  it("cancels the quit when the question cannot be shown", async () => {
    const quit = harness({ confirmDiscardDrafts: async () => { throw new Error("dialog failed"); } });
    createQuitController(quit.steps).request("user");
    await vi.advanceTimersByTimeAsync(0);
    expect(quit.calls).toEqual(["warn:quit.drafts-question-failed"]);
    expect(quit.exits()).toBe(0);
  });

  it("never asks at a session end, and a session end during the question goes on", async () => {
    const quit = harness({ confirmDiscardDrafts: vi.fn(async () => true) });
    createQuitController(quit.steps).request("session-end");
    await vi.advanceTimersByTimeAsync(0);
    expect(quit.steps.confirmDiscardDrafts).not.toHaveBeenCalled();
    expect(quit.exits()).toBe(1);

    const drafts = asking();
    drafts.quit.steps.dismissQuestion = () => { drafts.quit.calls.push("dismiss"); drafts.answer(false); };
    const controller = createQuitController(drafts.quit.steps);
    controller.request("user");
    await vi.advanceTimersByTimeAsync(0);
    controller.request("session-end");
    await vi.advanceTimersByTimeAsync(0);
    expect(drafts.quit.calls).toEqual(["dismiss", "flush", "save", "close", "exit"]);
  });
});

describe("a session end", () => {
  it("never asks, logs what failed and exits", async () => {
    const quit = harness();
    quit.steps.save = failingSave(["queue"], Infinity, quit.calls);
    createQuitController(quit.steps).request("session-end");
    await vi.advanceTimersByTimeAsync(0);

    expect(quit.calls).toEqual(["flush", "save", "close", "exit"]);
    expect(quit.asked).toEqual([]);
  });

  it("kills the process 4 s after it began when no step finishes, under the 5 s Windows allows", async () => {
    const quit = harness({ flushEdits: never, save: never, close: never });
    createQuitController(quit.steps).request("session-end");

    await vi.advanceTimersByTimeAsync(3_999);
    expect(quit.exits()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(quit.calls.filter((call) => call === "kill" || call === "exit")).toEqual(["kill"]);
    expect(quit.asked).toEqual([]);
  });

  it("closes the user's open question and saves once more without asking", async () => {
    const quit = harness();
    quit.steps.save = failingSave(["settings"], Infinity, quit.calls);
    const controller = createQuitController(quit.steps);
    controller.request("user");
    await vi.advanceTimersByTimeAsync(0);
    expect(quit.asked).toHaveLength(1);

    controller.request("session-end");
    await vi.advanceTimersByTimeAsync(0);

    expect(quit.calls).toEqual(["flush", "save", "ask", "dismiss", "flush", "save", "close", "exit"]);
    expect(quit.asked, "asked only before the session end").toHaveLength(1);
  });

  it("ends a user's quit stuck in its save 4 s after the session end arrives", async () => {
    const quit = harness({ save: never, close: never });
    const controller = createQuitController(quit.steps);
    controller.request("user");
    await vi.advanceTimersByTimeAsync(1_000);

    controller.request("session-end");
    controller.request("session-end");
    await vi.advanceTimersByTimeAsync(3_999);
    expect(quit.exits()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(quit.calls.filter((call) => call === "kill" || call === "exit")).toEqual(["kill"]);
    expect(quit.asked).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(quit.exits(), "the process ends once").toBe(1);
  });
});

describe("the unsaved-changes question", () => {
  it("offers Keep editing, focused, then Discard, and names the quit", () => {
    const translator = createTranslator("en");
    const quit = discardDraftsDialog(translator);
    expect(quit.actions.map((action) => [action.choice, action.label, action.tone])).toEqual([["cancel", "Keep editing", undefined], ["discard", "Discard", "danger"]]);
    expect([quit.focus, quit.dismiss]).toEqual(["cancel", "cancel"]);
    expect(quit.body).toBe("You have unsaved changes in Settings. Discard them and quit?");
  });
});

describe("the running-work question", () => {
  it("asks nothing when no work runs", () => {
    expect(stopWorkDialog(createTranslator("en"), { recordings: 0, tools: 0 })).toBeNull();
  });

  it("names the work a quit would stop, keeps working by default, and stops it only on request", () => {
    const dialog = stopWorkDialog(createTranslator("en"), { recordings: 2, tools: 1 })!;
    expect(dialog.title).toBe("Mumbler is still working");
    expect(dialog.body).toBe(
      "2 recordings are still being processed. Quitting stops them; you can generate or save them again later. "
      + "1 audio tool is still being installed. Quitting stops the installation.",
    );
    expect(dialog.actions.map((action) => [action.choice, action.label, action.tone])).toEqual([["cancel", "Keep Working", undefined], ["quit", "Stop and Quit", "danger"]]);
    expect([dialog.focus, dialog.dismiss]).toEqual(["cancel", "cancel"]);
  });
});

describe("running work at a user's quit", () => {
  it("asks before the drafts question, and keeps the app and its work on Keep working", async () => {
    let finish!: (proceed: boolean) => void;
    const quit = harness();
    quit.steps.confirmStopWork = () => { quit.calls.push("work"); return new Promise((resolve) => { finish = resolve; }); };
    quit.steps.confirmDiscardDrafts = async () => { quit.calls.push("drafts"); return true; };
    const controller = createQuitController(quit.steps);

    controller.request("user");
    await vi.advanceTimersByTimeAsync(0);
    expect(quit.calls, "nothing stops while the question is open").toEqual(["work"]);
    finish(false);
    await vi.advanceTimersByTimeAsync(0);

    expect(quit.calls).toEqual(["work"]);
    expect(quit.exits()).toBe(0);
    expect(controller.isRunning()).toBe(false);
  });

  it("stops the work and quits through the ordinary save on Stop and quit", async () => {
    const quit = harness();
    quit.steps.confirmStopWork = async () => { quit.calls.push("work"); return true; };
    createQuitController(quit.steps).request("user");
    await vi.advanceTimersByTimeAsync(0);
    expect(quit.calls).toEqual(["work", "flush", "save", "close", "exit"]);
  });

  it("never asks at a session end, and one that arrives during the question goes on", async () => {
    const quit = harness();
    quit.steps.confirmStopWork = () => { quit.calls.push("work"); return never<boolean>(); };
    const controller = createQuitController(quit.steps);
    controller.request("user");
    await vi.advanceTimersByTimeAsync(0);
    controller.request("session-end");
    await vi.advanceTimersByTimeAsync(4_500);
    expect(quit.calls).toContain("dismiss");
    expect(quit.exits()).toBe(1);

    const ending = harness();
    ending.steps.confirmStopWork = async () => { ending.calls.push("work"); return false; };
    createQuitController(ending.steps).request("session-end");
    await vi.advanceTimersByTimeAsync(0);
    expect(ending.calls).not.toContain("work");
    expect(ending.exits()).toBe(1);
  });
});

describe("the failed-save question", () => {
  beforeAll(() => loadCatalogue("ja"));

  it("names what failed, offers Cancel, Retry and Quit anyway in that order, and focuses Retry", () => {
    const dialog = quitFailureDialog(createTranslator("en"), ["queue", "settings"]);

    expect(dialog.body).toBe(
      "Mumbler could not save the queue and the settings. Retry, or quit anyway and lose what could not be saved.",
    );
    expect(dialog.actions.map((action) => [action.choice, action.label, action.tone])).toEqual([
      ["cancel", "Cancel", undefined],
      ["retry", "Retry", "primary"],
      ["quit-anyway", "Quit Anyway", "danger"],
    ]);
    expect(dialog.focus).toBe("retry");
    expect(dialog.dismiss).toBe("cancel");
  });

  it("distinguishes an unfinished save from an unavailable draft check", () => {
    expect(quitFailureDialog(createTranslator("en"), "stalled").body).toContain("could not finish saving your work in time");
    const unavailable = quitFailureDialog(createTranslator("en"), "drafts-unavailable");
    expect(unavailable.body).toContain("could not check for unsaved Settings changes");
    expect(unavailable.actions.map((action) => action.choice)).toEqual(["cancel", "quit-anyway"]);
    expect(unavailable.focus).toBe("cancel");
  });

  it("speaks the interface language", () => {
    const dialog = quitFailureDialog(createTranslator("ja"), ["settings"]);

    expect(dialog.language).toBe("ja");
    expect(dialog.body).toContain("Mumblerは設定を保存できませんでした");
    expect(dialog.actions.map((action) => action.label)).toEqual(["キャンセル", "再試行", "このまま終了"]);
  });
});
