import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AskAnswer } from "@rennet/types";
import { describe, expect, it, vi } from "vitest";
import { askReview, type ReviewAskPorts } from "./review-ask";

// The routing law for issue #139, proven directly. The whole point of the issue is
// a NEGATIVE guarantee — nothing fires to a second model behind the reviewer's
// back, and no merged answer is ever manufactured — so these tests assert what is
// NOT called and what field does NOT exist, not just the happy path.

/** A pair of recording ports with an ordered call log shared between them. */
function ports(): {
  ports: ReviewAskPorts;
  order: string[];
  askOrchestrator: ReturnType<typeof vi.fn>;
  askCodex: ReturnType<typeof vi.fn>;
} {
  const order: string[] = [];
  const askOrchestrator = vi.fn<(question: string) => Promise<AskAnswer>>(async () => {
    order.push("orchestrator");
    return { model: "Orchestrator · Claude", answer: "the orchestrator's answer" };
  });
  const askCodex = vi.fn<(question: string) => Promise<AskAnswer>>(async () => {
    order.push("codex");
    return { model: "codex", answer: "the second opinion" };
  });
  return { ports: { askOrchestrator, askCodex }, order, askOrchestrator, askCodex };
}

describe("askReview — orchestrator mode (the default)", () => {
  it("asks the orchestrator EXACTLY once and Codex ZERO times", async () => {
    const { ports: p, askOrchestrator, askCodex } = ports();
    await askReview("orchestrator", "is the retry-after in seconds or ms?", p);
    expect(askOrchestrator).toHaveBeenCalledTimes(1);
    expect(askOrchestrator).toHaveBeenCalledWith("is the retry-after in seconds or ms?");
    expect(askCodex).not.toHaveBeenCalled();
  });

  it("returns ONLY the primary answer — no secondOpinion key at all", async () => {
    const { ports: p } = ports();
    const result = await askReview("orchestrator", "q", p);
    expect(result.mode).toBe("orchestrator");
    expect(result.primary).toEqual({
      model: "Orchestrator · Claude",
      answer: "the orchestrator's answer",
    });
    expect(result.secondOpinion).toBeUndefined();
    // The KEY is absent, not merely undefined — there is no second answer to speak of.
    expect(Object.keys(result).sort()).toEqual(["mode", "primary"]);
  });
});

describe("askReview — both mode (the per-message opt-in)", () => {
  it("asks the orchestrator once AND Codex once — each with the same question", async () => {
    const { ports: p, askOrchestrator, askCodex } = ports();
    await askReview("both", "does the client agree?", p);
    expect(askOrchestrator).toHaveBeenCalledTimes(1);
    expect(askCodex).toHaveBeenCalledTimes(1);
    expect(askOrchestrator).toHaveBeenCalledWith("does the client agree?");
    expect(askCodex).toHaveBeenCalledWith("does the client agree?");
  });

  it("asks the orchestrator BEFORE Codex (the orchestrator is the one you converse with)", async () => {
    const { ports: p, order } = ports();
    await askReview("both", "q", p);
    expect(order).toEqual(["orchestrator", "codex"]);
  });

  it("returns TWO separately-labelled answers — primary + secondOpinion, verbatim", async () => {
    const { ports: p } = ports();
    const result = await askReview("both", "q", p);
    expect(result.mode).toBe("both");
    expect(result.primary).toEqual({
      model: "Orchestrator · Claude",
      answer: "the orchestrator's answer",
    });
    expect(result.secondOpinion).toEqual({ model: "codex", answer: "the second opinion" });
    // The two answers carry DISTINCT model labels — the reviewer always knows who said what.
    expect(result.primary.model).not.toBe(result.secondOpinion?.model);
  });

  it("produces NO third, merged answer — the result has exactly {mode, primary, secondOpinion}", async () => {
    const { ports: p } = ports();
    const result = await askReview("both", "q", p);
    // If a synthesis/merge ever crept in it would have to live in a third field; it cannot.
    expect(Object.keys(result).sort()).toEqual(["mode", "primary", "secondOpinion"]);
  });

  it("passes each port's answer through UNCHANGED — the router never rewrites or blends text", async () => {
    const p: ReviewAskPorts = {
      askOrchestrator: async () => ({ model: "Orchestrator · Claude", answer: "ms here" }),
      askCodex: async () => ({ model: "codex", answer: "milliseconds, client divides by 1000" }),
    };
    const result = await askReview("both", "q", p);
    // Byte-for-byte the ports' outputs — nothing is concatenated, summarised, or reconciled.
    expect(result.primary.answer).toBe("ms here");
    expect(result.secondOpinion?.answer).toBe("milliseconds, client divides by 1000");
  });
});

describe("askReview — the no-synthesis invariant, structurally", () => {
  it("the routing source contains no answer-combining call (grep half of the acceptance)", () => {
    // The runtime tests above prove the behaviour; this is the static "grep" half of
    // the acceptance criterion, scoped to the routing source. We assert the source
    // never CALLS a combiner over the two answers. (We match call sites like
    // `merge(` / `synthesize(` / `reconcile(` / `combine(`, not prose — the module's
    // own comments explain the invariant using those words, so a bare word match
    // would be a burned needle.)
    const source = readFileSync(fileURLToPath(new URL("./review-ask.ts", import.meta.url)), "utf8");
    const combinerCall = /\b(synthesi[sz]e|reconcile|mergeAnswers?|combineAnswers?)\s*\(/i;
    expect(source).not.toMatch(combinerCall);
    // Positive control: the pattern DOES match a real combiner call, so a zero above
    // is a real absence, not a broken regex (Rule 81ak — a must-be-able-to-match control).
    expect("const x = synthesize(a, b);").toMatch(combinerCall);
  });
});
