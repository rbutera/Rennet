import {
  type AskAnswer,
  askReview,
  type CodexExecRequest,
  type CodexExecResult,
  type HandoffRunInput,
  type HandoffRunOutcome,
  type HandoffRunPort,
} from "@rennet/core";
import type { Patchset, Review } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  buildCodexAskPrompt,
  buildOrchestratorAskPrompt,
  CODEX_ASK_DIFF_CEILING,
  CODEX_ASK_LABEL,
  CODEX_ASK_OUTPUT_SCHEMA,
  createLiveCodexAsk,
  createLiveOrchestratorAsk,
  createLiveReviewAskPorts,
  NO_HARNESS_ANSWER,
  ORCHESTRATOR_ASK_DIFF_CEILING,
  ORCHESTRATOR_ASK_LABEL,
} from "./review-ask-live";

// ─────────────────────────────────────────────────────────────────────────────
// The LIVE review.ask ports (issue #139; orchestrator leg relit by F1, #570). Both
// legs are proven hermetically with fakes — the orchestrator against a fake
// `HandoffRunPort`, Codex against a fake executor — plus the router's no-synthesis
// law. No Electron, no real `claude`, no real `codex`.
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

/** A fake turn port: records its input, replays a scripted delta list, returns `outcome`. */
function fakeRunPort(
  outcome: HandoffRunOutcome,
  deltas: readonly string[] = [],
): { port: HandoffRunPort; input: () => HandoffRunInput | null } {
  let seen: HandoffRunInput | null = null;
  return {
    port: (input) => {
      seen = input;
      for (const delta of deltas) input.onDelta?.(delta);
      return Promise.resolve(outcome);
    },
    input: () => seen,
  };
}

describe("createLiveOrchestratorAsk", () => {
  it("returns the turn's real final text under the orchestrator label", async () => {
    const fake = fakeRunPort({ status: "completed", finalText: "  b is new and unused.  " });
    const ask = createLiveOrchestratorAsk({ resolveRunPort: () => Promise.resolve(fake.port) });
    const answer = await ask({ review: review(), question: "what changed?" });
    expect(answer.model).toBe(ORCHESTRATOR_ASK_LABEL);
    // The FAKE PORT's text, not any canned constant — the assertion that would have
    // caught the Board-rebuild string masquerading as an answer.
    expect(answer.answer).toBe("b is new and unused.");
    expect(answer.answer).not.toMatch(/Board rebuild/i);
  });

  it("streams deltas to onDelta in arrival order and runs at the repository root", async () => {
    const fake = fakeRunPort({ status: "completed", finalText: "done" }, ["b ", "is ", "new"]);
    const ask = createLiveOrchestratorAsk({ resolveRunPort: () => Promise.resolve(fake.port) });
    const seen: string[] = [];
    await ask({ review: review(), question: "q", onDelta: (text) => seen.push(text) });
    expect(seen).toEqual(["b ", "is ", "new"]);
    expect(fake.input()?.cwd).toBe("/repo");
  });

  it("surfaces the port's REAL failure reason, never a summary", async () => {
    const fake = fakeRunPort({
      status: "failed",
      reason: "the handoff session failed to start: ENOENT",
    });
    const ask = createLiveOrchestratorAsk({ resolveRunPort: () => Promise.resolve(fake.port) });
    const answer = await ask({ review: review(), question: "q" });
    expect(answer.answer).toBe(
      "The orchestrator could not answer: the handoff session failed to start: ENOENT",
    );
  });

  it("answers honestly, naming claude, when no harness is installed", async () => {
    const ask = createLiveOrchestratorAsk({ resolveRunPort: () => Promise.resolve(null) });
    const answer = await ask({ review: review(), question: "q" });
    expect(answer.answer).toBe(NO_HARNESS_ANSWER);
    expect(answer.answer).toMatch(/claude/);
  });

  it("never throws into the router — a resolver throw becomes an honest answer", async () => {
    const ask = createLiveOrchestratorAsk({
      resolveRunPort: () => Promise.reject(new Error("probe exploded")),
    });
    const answer = await ask({ review: review(), question: "q" });
    expect(answer.answer).toBe("The orchestrator could not answer: probe exploded");
  });

  it("threads the abort controller's signal into the turn", async () => {
    const fake = fakeRunPort({ status: "completed", finalText: "ok" });
    const ask = createLiveOrchestratorAsk({ resolveRunPort: () => Promise.resolve(fake.port) });
    const abortController = new AbortController();
    await ask({ review: review(), question: "q", abortController });
    expect(fake.input()?.signal).toBe(abortController.signal);
  });
});

describe("buildOrchestratorAskPrompt", () => {
  it("carries the question, the repository root, the patchset identity and the diff", () => {
    const prompt = buildOrchestratorAskPrompt(review(), "is b used anywhere?");
    expect(prompt).toContain("is b used anywhere?");
    expect(prompt).toContain("/repo");
    expect(prompt).toContain("def");
    // The distinctive hunk — the diff really reaches the model, not just a summary.
    expect(prompt).toContain("+export const b = 2;");
    expect(prompt).toMatch(/do NOT commit/i);
  });

  it("folds the reviewer's selection in when present", () => {
    const prompt = buildOrchestratorAskPrompt(review(), "q", {
      anchor: "src/a.ts:2",
      excerpt: "export const b = 2;",
    });
    expect(prompt).toContain("src/a.ts:2");
    expect(prompt).toContain("export const b = 2;");
  });

  it("byte-bounds the diff at the declared ceiling", () => {
    const base = review();
    const [first] = base.patchsets;
    if (!first) throw new Error("the fixture review has no patchset");
    const fat: Review = {
      ...base,
      patchsets: [{ ...first, rawDiff: "x".repeat(ORCHESTRATOR_ASK_DIFF_CEILING * 3) }],
    };
    const prompt = buildOrchestratorAskPrompt(fat, "q");
    const diffRun = prompt.match(/x+/)?.[0] ?? "";
    expect(diffRun.length).toBeLessThanOrEqual(ORCHESTRATOR_ASK_DIFF_CEILING);
    expect(prompt).toContain("diff truncated");
  });
});

describe("createLiveReviewAskPorts — askOrchestrator", () => {
  it("delegates to the injected live orchestrator, passing the stream sink through", async () => {
    const seen: string[] = [];
    const ports = createLiveReviewAskPorts({
      askOrchestrator: ({ question, onDelta }) => {
        onDelta?.("tok");
        return Promise.resolve({ model: ORCHESTRATOR_ASK_LABEL, answer: `answered: ${question}` });
      },
    });
    const answer = await ports.askOrchestrator({
      review: review(),
      question: "why?",
      onDelta: (text) => seen.push(text),
    });
    expect(answer.answer).toBe("answered: why?");
    expect(seen).toEqual(["tok"]);
  });

  it("answers the honest no-harness line — never a Board-rebuild sentence — with no dep", async () => {
    const ports = createLiveReviewAskPorts({});
    const answer = await ports.askOrchestrator({ review: review(), question: "q" });
    expect(answer.model).toBe(ORCHESTRATOR_ASK_LABEL);
    expect(answer.answer).toBe(NO_HARNESS_ANSWER);
    expect(answer.answer).not.toMatch(/Board rebuild/i);
  });

  it("orchestrator-only never touches Codex, and both returns two unmerged answers", async () => {
    const codex = vi.fn(() =>
      Promise.resolve({ model: CODEX_ASK_LABEL, answer: "codex says" } as AskAnswer),
    );
    const ports = createLiveReviewAskPorts({
      askOrchestrator: () =>
        Promise.resolve({ model: ORCHESTRATOR_ASK_LABEL, answer: "orchestrator says" }),
      askCodex: codex,
    });
    const r = review();
    const bind = {
      askOrchestrator: (question: string) => ports.askOrchestrator({ review: r, question }),
      askCodex: (question: string) => ports.askCodex({ review: r, question }),
    };
    const solo = await askReview("orchestrator", "q", bind);
    expect(codex).not.toHaveBeenCalled();
    expect(solo.primary.answer).toBe("orchestrator says");
    expect(solo.secondOpinion).toBeUndefined();

    const both = await askReview("both", "q", bind);
    expect(codex).toHaveBeenCalledTimes(1);
    // Side by side, never synthesized into one.
    expect(both.primary.answer).toBe("orchestrator says");
    expect(both.secondOpinion?.answer).toBe("codex says");
  });
});

describe("createLiveReviewAskPorts — askCodex", () => {
  it("delegates to the live codex port with the given review + question", async () => {
    const askCodex = vi.fn(
      async (): Promise<AskAnswer> => ({ model: CODEX_ASK_LABEL, answer: "codex says ms" }),
    );
    const ports = createLiveReviewAskPorts({ askCodex });
    const r = review("review-7");
    const answer = await ports.askCodex({ review: r, question: "seconds or ms?" });
    expect(askCodex).toHaveBeenCalledWith({ review: r, question: "seconds or ms?" });
    expect(answer).toEqual({ model: CODEX_ASK_LABEL, answer: "codex says ms" });
  });

  it("forwards the AbortController to the live codex port (#251 criterion 4)", async () => {
    const askCodex = vi.fn(
      async (): Promise<AskAnswer> => ({ model: CODEX_ASK_LABEL, answer: "ok" }),
    );
    const ports = createLiveReviewAskPorts({ askCodex });
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
    const ports = createLiveReviewAskPorts({});
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
