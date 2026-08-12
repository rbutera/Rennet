import {
  type AskAnswer,
  askReview,
  type CodexExecRequest,
  type CodexExecResult,
  type ReviewPipelineResult,
} from "@rennet/core";
import type { Patchset, Review } from "@rennet/types";
import { describe, expect, it, vi } from "vitest";
import type { OrchestratorTurnOutcome, OrchestratorTurnRunner } from "./orchestrator";
import {
  buildCodexAskPrompt,
  CODEX_ASK_DIFF_CEILING,
  CODEX_ASK_LABEL,
  CODEX_ASK_OUTPUT_SCHEMA,
  createLiveCodexAsk,
  createLiveReviewAskPorts,
  ORCHESTRATOR_ASK_LABEL,
} from "./review-ask-live";

// ─────────────────────────────────────────────────────────────────────────────
// The LIVE review.ask ports (issue #139, bead workspace-alqow). Driven with NO
// model and NO codex: fakes stand in for the orchestrator turn runner and the
// codex executor, so the whole mapping + the no-synthesis contract are proven
// hermetically. The gated real-turn proof (orchestrator-live.real.test.ts) covers
// the actual model path.
// ─────────────────────────────────────────────────────────────────────────────

function review(id = "review-1"): Review {
  const patchset: Patchset = {
    id: "ps-1",
    createdAt: "2026-08-11T00:00:00.000Z",
    repository: {
      id: "repo",
      root: "/repo",
      commonDir: "/repo/.git",
      baseRef: "abc",
      baseOid: "abc",
      headOid: "def",
    },
    files: [],
    rawDiff: "@@ -1,1 +1,2 @@\n export const a = 1;\n+export const b = 2;",
    byteLength: 10,
    truncated: false,
  };
  return {
    id,
    repositoryRoot: "/repo",
    patchsets: [patchset],
    activePatchsetId: patchset.id,
    dispositions: [],
    status: "current",
  };
}

/** A minimal `OrchestratorTurnResult` for a completed turn with the given text. */
function completed(finalText: string): OrchestratorTurnOutcome {
  return {
    available: true,
    result: {
      session: {} as never,
      toolCalls: [],
      finalText,
      outcome: "completed",
    },
  };
}

const pipeline = {} as ReviewPipelineResult;
const buildPipeline = () => Promise.resolve(pipeline);

describe("createLiveReviewAskPorts — askOrchestrator", () => {
  it("builds the pipeline over the given review, drives the turn, and returns its final text", async () => {
    const turn = vi.fn<OrchestratorTurnRunner>(() =>
      Promise.resolve(completed("the retry-after is in milliseconds")),
    );
    const built = vi.fn<(r: Review) => Promise<ReviewPipelineResult>>(() =>
      Promise.resolve(pipeline),
    );
    const ports = createLiveReviewAskPorts({ buildPipeline: built, orchestratorTurn: turn });
    const r = review("review-9");
    const answer = await ports.askOrchestrator({ review: r, question: "seconds or ms?" });

    // The pipeline is built over the SAME review dispatch resolved (never re-fetched).
    expect(built).toHaveBeenCalledWith(r);
    // The 4th arg is the #251 onDelta sink — undefined here (this ask supplies none).
    expect(turn).toHaveBeenCalledWith(r, pipeline, "seconds or ms?", undefined);
    expect(answer).toEqual({
      model: ORCHESTRATOR_ASK_LABEL,
      answer: "the retry-after is in milliseconds",
    });
  });

  it("threads the AbortController into the turn runner as the 5th arg (#251 criterion 4)", async () => {
    const turn = vi.fn<OrchestratorTurnRunner>(() => Promise.resolve(completed("ok")));
    const ports = createLiveReviewAskPorts({ buildPipeline, orchestratorTurn: turn });
    const controller = new AbortController();
    const r = review();
    await ports.askOrchestrator({ review: r, question: "q", abortController: controller });
    // The VERY controller reaches the runner (which hands it to the SDK). Drop the
    // threading and this reddens (the runner would be called with only four args).
    expect(turn).toHaveBeenCalledWith(r, pipeline, "q", undefined, controller);
  });

  it("calls the runner with exactly four args when NO controller is supplied (back-compat)", async () => {
    const turn = vi.fn<OrchestratorTurnRunner>(() => Promise.resolve(completed("ok")));
    const ports = createLiveReviewAskPorts({ buildPipeline, orchestratorTurn: turn });
    const r = review();
    await ports.askOrchestrator({ review: r, question: "q" });
    // No abort seam ⇒ the runner's original four-arg shape is preserved unchanged.
    expect(turn).toHaveBeenCalledWith(r, pipeline, "q", undefined);
  });

  it("returns an HONEST unavailable answer (never a fabricated one) when no claude is present", async () => {
    const ports = createLiveReviewAskPorts({
      buildPipeline,
      orchestratorTurn: () =>
        Promise.resolve({ available: false, reason: "no claude binary is available" }),
    });
    const answer = await ports.askOrchestrator({ review: review(), question: "q" });
    expect(answer.model).toBe(ORCHESTRATOR_ASK_LABEL);
    expect(answer.answer).toMatch(/unavailable: no claude/i);
  });

  it("returns an HONEST failed answer carrying the harness error when the turn fails", async () => {
    const ports = createLiveReviewAskPorts({
      buildPipeline,
      orchestratorTurn: () =>
        Promise.resolve({
          available: true,
          result: {
            session: {} as never,
            toolCalls: [],
            finalText: "",
            outcome: "failed",
            error: {
              class: "unknown",
              origin: "harness",
              message: "the model rejected the turn",
              retryable: false,
              retryableSource: "inferred",
              nativeCode: null,
            },
          },
        }),
    });
    const answer = await ports.askOrchestrator({ review: review(), question: "q" });
    expect(answer.answer).toMatch(/failed: the model rejected the turn/i);
  });

  it("does not pass an empty final answer off as the model's reply", async () => {
    const ports = createLiveReviewAskPorts({
      buildPipeline,
      orchestratorTurn: () => Promise.resolve(completed("   ")),
    });
    const answer = await ports.askOrchestrator({ review: review(), question: "q" });
    expect(answer.answer).toMatch(/without a final answer/i);
  });
});

describe("createLiveReviewAskPorts — askCodex", () => {
  it("delegates to the live codex port with the given review + question", async () => {
    const askCodex = vi.fn(
      async (): Promise<AskAnswer> => ({ model: CODEX_ASK_LABEL, answer: "codex says ms" }),
    );
    const ports = createLiveReviewAskPorts({
      buildPipeline,
      orchestratorTurn: () => Promise.resolve(completed("x")),
      askCodex,
    });
    const r = review("review-7");
    const answer = await ports.askCodex({ review: r, question: "seconds or ms?" });
    expect(askCodex).toHaveBeenCalledWith({ review: r, question: "seconds or ms?" });
    expect(answer).toEqual({ model: CODEX_ASK_LABEL, answer: "codex says ms" });
  });

  it("forwards the AbortController to the live codex port (#251 criterion 4)", async () => {
    const askCodex = vi.fn(
      async (): Promise<AskAnswer> => ({ model: CODEX_ASK_LABEL, answer: "ok" }),
    );
    const ports = createLiveReviewAskPorts({
      buildPipeline,
      orchestratorTurn: () => Promise.resolve(completed("x")),
      askCodex,
    });
    const controller = new AbortController();
    const r = review("review-7");
    await ports.askCodex({ review: r, question: "q", abortController: controller });
    expect(askCodex).toHaveBeenCalledWith({
      review: r,
      question: "q",
      abortController: controller,
    });
  });

  it("returns an honest unavailable answer when no codex port is wired", async () => {
    const ports = createLiveReviewAskPorts({
      buildPipeline,
      orchestratorTurn: () => Promise.resolve(completed("x")),
    });
    const answer = await ports.askCodex({ review: review(), question: "q" });
    expect(answer.model).toBe(CODEX_ASK_LABEL);
    expect(answer.answer).toMatch(/not installed/i);
  });
});

describe("the LIVE ports preserve the no-synthesis law through the real askReview router", () => {
  function livePorts(): {
    askOrchestrator: (i: { review: Review; question: string }) => Promise<AskAnswer>;
    askCodex: (i: { review: Review; question: string }) => Promise<AskAnswer>;
  } {
    return createLiveReviewAskPorts({
      buildPipeline,
      orchestratorTurn: () => Promise.resolve(completed("orchestrator answer")),
      askCodex: async () => ({ model: CODEX_ASK_LABEL, answer: "codex answer" }),
    });
  }

  it("orchestrator mode asks the orchestrator ONCE and Codex ZERO times", async () => {
    const ports = livePorts();
    const r = review();
    const orchestrator = vi.fn((question: string) =>
      ports.askOrchestrator({ review: r, question }),
    );
    const codex = vi.fn((question: string) => ports.askCodex({ review: r, question }));
    const result = await askReview("orchestrator", "seconds or ms?", {
      askOrchestrator: orchestrator,
      askCodex: codex,
    });
    expect(orchestrator).toHaveBeenCalledTimes(1);
    expect(codex).not.toHaveBeenCalled();
    expect(result.mode).toBe("orchestrator");
    expect(result.primary.model).toBe(ORCHESTRATOR_ASK_LABEL);
    expect(result.secondOpinion).toBeUndefined();
  });

  it("both mode returns two labelled answers side by side and NO third (merged) field", async () => {
    const ports = livePorts();
    const r = review();
    const result = await askReview("both", "does the client agree?", {
      askOrchestrator: (question) => ports.askOrchestrator({ review: r, question }),
      askCodex: (question) => ports.askCodex({ review: r, question }),
    });
    expect(result.mode).toBe("both");
    expect(result.primary.model).toBe(ORCHESTRATOR_ASK_LABEL);
    expect(result.secondOpinion?.model).toBe(CODEX_ASK_LABEL);
    // The shape itself cannot express a synthesized answer — exactly these keys.
    expect(Object.keys(result).sort()).toEqual(["mode", "primary", "secondOpinion"]);
  });
});

describe("createLiveCodexAsk", () => {
  function execResult(output: unknown): CodexExecResult {
    return { output };
  }

  it("shells the executor with the question + diff constrained to the answer schema", async () => {
    const executor = vi.fn<(req: CodexExecRequest) => Promise<CodexExecResult>>(() =>
      Promise.resolve(execResult({ answer: "milliseconds; the wrapper divides by 1000" })),
    );
    const ask = createLiveCodexAsk({ executor });
    const answer = await ask({ review: review(), question: "seconds or ms?" });

    const req = executor.mock.calls[0]?.[0];
    expect(req?.outputSchema).toBe(CODEX_ASK_OUTPUT_SCHEMA);
    expect(req?.prompt).toContain("seconds or ms?");
    expect(req?.prompt).toContain("export const b = 2;"); // the diff is inlined
    expect(answer).toEqual({
      model: CODEX_ASK_LABEL,
      answer: "milliseconds; the wrapper divides by 1000",
    });
  });

  it("passes the AbortController's signal to the executor as execa's cancelSignal (#251 criterion 4)", async () => {
    const executor = vi.fn<(req: CodexExecRequest) => Promise<CodexExecResult>>(() =>
      Promise.resolve(execResult({ answer: "ok" })),
    );
    const ask = createLiveCodexAsk({ executor });
    const controller = new AbortController();
    await ask({ review: review(), question: "q", abortController: controller });
    // The exec receives the SAME signal the quit-abort fires — that is what force-kills
    // the codex child. Drop the threading and `req.signal` is undefined, reddening this.
    expect(executor.mock.calls[0]?.[0]?.signal).toBe(controller.signal);
  });

  it("passes NO signal to the executor when no controller is supplied (back-compat)", async () => {
    const executor = vi.fn<(req: CodexExecRequest) => Promise<CodexExecResult>>(() =>
      Promise.resolve(execResult({ answer: "ok" })),
    );
    await createLiveCodexAsk({ executor })({ review: review(), question: "q" });
    expect(executor.mock.calls[0]?.[0]?.signal).toBeUndefined();
  });

  it("reports an honest 'no answer' when codex returns an empty/absent answer", async () => {
    const ask = createLiveCodexAsk({
      executor: () => Promise.resolve(execResult({ answer: "  " })),
    });
    const answer = await ask({ review: review(), question: "q" });
    expect(answer.answer).toMatch(/no answer/i);
  });

  it("degrades honestly (never crashes) when the codex exec throws", async () => {
    const ask = createLiveCodexAsk({
      executor: () => Promise.reject(new Error("codex exec exited 1: no stderr")),
    });
    const answer = await ask({ review: review(), question: "q" });
    expect(answer.model).toBe(CODEX_ASK_LABEL);
    expect(answer.answer).toMatch(/could not answer: codex exec exited 1/i);
  });
});

describe("buildCodexAskPrompt", () => {
  it("inlines the question and the diff", () => {
    const prompt = buildCodexAskPrompt("@@ diff @@\n+line", "why?");
    expect(prompt).toContain("why?");
    expect(prompt).toContain("+line");
  });

  it("bounds a huge diff with a truncation marker", () => {
    const huge = "x".repeat(CODEX_ASK_DIFF_CEILING + 500);
    const prompt = buildCodexAskPrompt(huge, "q");
    expect(prompt).toContain("diff truncated");
    // The inlined diff body never exceeds the ceiling (+ the marker line).
    expect(prompt.length).toBeLessThan(CODEX_ASK_DIFF_CEILING + 300);
  });

  it("honours the BYTE bound for a multi-byte diff (never code units)", () => {
    // Each "€" is 3 UTF-8 bytes but 1 code unit. A code-unit slice would keep
    // CEILING chars = ~3x CEILING bytes; the byte-correct clip must not.
    const multibyte = "€".repeat(CODEX_ASK_DIFF_CEILING);
    const prompt = buildCodexAskPrompt(multibyte, "q");
    expect(prompt).toContain("diff truncated");
    // The inlined diff (everything before the marker) is within the BYTE ceiling.
    const diffPart = prompt.slice(0, prompt.indexOf("\n… (diff truncated"));
    const euroStart = diffPart.indexOf("€");
    const diffBody = diffPart.slice(euroStart);
    expect(new TextEncoder().encode(diffBody).length).toBeLessThanOrEqual(CODEX_ASK_DIFF_CEILING);
  });
});
