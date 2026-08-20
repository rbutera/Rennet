import type { AskReviewResult } from "@rennet/types";
import { describe, expect, it } from "vitest";
import {
  ASK_OPTIONS,
  askCards,
  askedBoth,
  askModeForThread,
  DEFAULT_ASK_MODE,
  rememberAskMode,
} from "./ask";

const ORCHESTRATOR_RESULT: AskReviewResult = {
  mode: "orchestrator",
  primary: { model: "Orchestrator · Claude", answer: "the orchestrator's answer" },
};

const BOTH_RESULT: AskReviewResult = {
  mode: "both",
  primary: { model: "Orchestrator · Claude", answer: "milliseconds, worth a rename" },
  secondOpinion: { model: "codex", answer: "milliseconds, client divides by 1000" },
};

describe("askModeForThread / rememberAskMode — per-thread memory", () => {
  it("defaults an unknown thread to the orchestrator-only default", () => {
    expect(askModeForThread({}, "thread-a")).toBe("orchestrator");
    expect(DEFAULT_ASK_MODE).toBe("orchestrator");
  });

  it("remembers a chosen mode for the SAME thread", () => {
    const next = rememberAskMode({}, "thread-a", "both");
    expect(askModeForThread(next, "thread-a")).toBe("both");
  });

  it("does NOT leak the choice to another thread (remembered per thread, not global)", () => {
    const next = rememberAskMode({}, "thread-a", "both");
    // A DIFFERENT thread is still at the default — the choice never went global.
    expect(askModeForThread(next, "thread-b")).toBe("orchestrator");
  });

  it("is immutable — remembering returns a new map and never mutates the input", () => {
    const before: Record<string, never> = {};
    const after = rememberAskMode(before, "thread-a", "both");
    expect(before).toEqual({});
    expect(after).not.toBe(before);
  });

  it("can be set back to orchestrator for one thread without touching others", () => {
    const a = rememberAskMode({}, "thread-a", "both");
    const b = rememberAskMode(a, "thread-b", "both");
    const backToDefault = rememberAskMode(b, "thread-a", "orchestrator");
    expect(askModeForThread(backToDefault, "thread-a")).toBe("orchestrator");
    expect(askModeForThread(backToDefault, "thread-b")).toBe("both");
  });
});

describe("askCards — the ordered, labelled answer cards", () => {
  it("renders exactly ONE card (the orchestrator) for an orchestrator result", () => {
    const cards = askCards(ORCHESTRATOR_RESULT);
    expect(cards).toEqual([
      { model: "Orchestrator · Claude", answer: "the orchestrator's answer" },
    ]);
  });

  it("renders exactly TWO cards, orchestrator first then codex, for a both result", () => {
    const cards = askCards(BOTH_RESULT);
    expect(cards.map((c) => c.model)).toEqual(["Orchestrator · Claude", "codex"]);
    expect(cards).toHaveLength(2);
  });

  it("passes each answer through VERBATIM — never a merged/synthesized third card", () => {
    const cards = askCards(BOTH_RESULT);
    expect(cards[0]?.answer).toBe("milliseconds, worth a rename");
    expect(cards[1]?.answer).toBe("milliseconds, client divides by 1000");
    // There is no third card: the shape cannot express a synthesis.
    expect(cards).toHaveLength(2);
  });

  it("askedBoth is true only when a second opinion is present", () => {
    expect(askedBoth(BOTH_RESULT)).toBe(true);
    expect(askedBoth(ORCHESTRATOR_RESULT)).toBe(false);
  });
});

describe("ASK_OPTIONS — the caret menu options", () => {
  it("offers orchestrator (default) then both (two answers), in that order", () => {
    expect(ASK_OPTIONS.map((o) => o.mode)).toEqual(["orchestrator", "both"]);
    expect(ASK_OPTIONS[0]?.hint).toBe("default");
    expect(ASK_OPTIONS[1]?.hint).toBe("two answers");
  });
});
