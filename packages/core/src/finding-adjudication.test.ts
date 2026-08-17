import type { FindingElement, OfferedManifest, RspTokenUsage } from "@rennet/types";
import { describe, expect, it, vi } from "vitest";
import {
  type AdjudicationTurn,
  type AdjudicationTurnResult,
  adjudicateFlaggedReview,
  DEFAULT_MAX_ADJUDICATIONS,
  runFindingAdjudication,
} from "./finding-adjudication";
import type { VerificationFileReader, VerificationFileWindow } from "./finding-verification";
import { createInvocationBudget } from "./invocation-budget";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MANIFEST: OfferedManifest = {
  occurrences: [
    { id: "h1", kind: "hunk", sides: { additions: ["const x = load();"] } },
    { id: "h2", kind: "hunk", sides: { additions: ["return y.value;"] } },
    { id: "h3", kind: "hunk", sides: { additions: ["race();"] } },
  ],
  lineage: [],
};

const WINDOWS: Record<string, VerificationFileWindow> = {
  "rennet:hunk/h1": {
    path: "a.ts",
    startLine: 1,
    endLine: 5,
    text: "const x = load();\nuse(x);\n// more real context than the hunk",
  },
  "rennet:hunk/h2": { path: "a.ts", startLine: 20, endLine: 24, text: "return y.value;" },
  "rennet:hunk/h3": { path: "b.ts", startLine: 1, endLine: 3, text: "race();" },
};

const readAll: VerificationFileReader = async (anchor) => WINDOWS[anchor];

const LABELS = { a: "Claude", b: "Codex" };

/** A disagree (solo) row: seat A flagged, seat B silent. */
function solo(findingId: string, overrides: Partial<FindingElement> = {}): FindingElement {
  const anchor = overrides.anchor ?? "rennet:hunk/h1";
  const summary = overrides.summary ?? "load() can return null and is dereferenced unguarded";
  return {
    findingId,
    anchor,
    summary,
    severity: overrides.severity ?? "high",
    agreement: {
      kind: "disagree",
      answers: [
        { model: LABELS.a, answer: summary },
        { model: LABELS.b, answer: "no concern raised here" },
      ],
    },
    ...overrides,
  };
}

function concur(findingId: string): FindingElement {
  return {
    findingId,
    anchor: "rennet:hunk/h2",
    summary: "both seats agree this is fine to flag",
    severity: "high",
    agreement: { kind: "concur", agree: 2, total: 2 },
  };
}

/** A turn that returns a verdict per contested row, keyed by the ref echoed from the prompt. */
function turnByRef(
  verdicts: Record<string, { verdict: string; evidence: string }>,
  opts: { fail?: string; tokens?: RspTokenUsage; capture?: (p: string) => void } = {},
): AdjudicationTurn {
  return async (prompt: string): Promise<AdjudicationTurnResult> => {
    opts.capture?.(prompt);
    if (opts.fail) return { status: "failed", message: opts.fail };
    const adjudications: { ref: string; verdict: string; evidence: string }[] = [];
    const match = /## Contested row (a\d+)/.exec(prompt);
    if (match) {
      const ref = match[1] as string;
      const v = verdicts[ref];
      if (v) adjudications.push({ ref, ...v });
    }
    return {
      status: "emitted",
      body: { adjudications },
      ...(opts.tokens ? { tokens: opts.tokens } : {}),
    };
  };
}

const budget = () => createInvocationBudget(10);
const BY = "opus-4.8 (claude-code)";

// ── 2.1 Selection ───────────────────────────────────────────────────────────

describe("runFindingAdjudication — selection (#41)", () => {
  it("adjudicates only disagree rows; concur rows spend nothing", async () => {
    const turn = vi.fn(turnByRef({ a1: { verdict: "supported", evidence: "line 2 derefs x" } }));
    const result = await runFindingAdjudication({
      findings: [concur("C1"), solo("S1")],
      manifest: MANIFEST,
      readFileWindow: readAll,
      runTurn: turn,
      adjudicatedBy: BY,
      budget: budget(),
    });
    expect(turn).toHaveBeenCalledTimes(1);
    const c = result.findings.find((f) => f.findingId === "C1");
    expect(c?.agreement.kind).toBe("concur");
    const s = result.findings.find((f) => f.findingId === "S1");
    expect(s?.agreement.kind === "disagree" && s.agreement.adjudication?.verdict).toBe("supported");
  });

  it("runs zero turns when every row concurs", async () => {
    const turn = vi.fn(turnByRef({}));
    const result = await runFindingAdjudication({
      findings: [concur("C1"), concur("C2")],
      manifest: MANIFEST,
      readFileWindow: readAll,
      runTurn: turn,
      adjudicatedBy: BY,
      budget: budget(),
    });
    expect(turn).not.toHaveBeenCalled();
    expect(result.telemetry.adjudicationTurns).toBe(0);
  });

  it("takes contested rows in severity order up to the cap; the rest are honest insufficient", async () => {
    const findings = [
      solo("LOW", { anchor: "rennet:hunk/h3", severity: "low" }),
      solo("HIGH", { anchor: "rennet:hunk/h1", severity: "high" }),
      solo("MED", { anchor: "rennet:hunk/h2", severity: "medium" }),
    ];
    const turn = vi.fn(
      turnByRef({
        a1: { verdict: "supported", evidence: "e" },
        a2: { verdict: "contradicted", evidence: "e" },
        a3: { verdict: "supported", evidence: "e" },
      }),
    );
    const result = await runFindingAdjudication({
      findings,
      manifest: MANIFEST,
      readFileWindow: readAll,
      runTurn: turn,
      adjudicatedBy: BY,
      budget: budget(),
      maxAdjudications: 2,
    });
    // Only the top-2 by severity (HIGH, MED) get a real turn; LOW is capped-insufficient.
    expect(turn).toHaveBeenCalledTimes(2);
    const low = result.findings.find((f) => f.findingId === "LOW");
    expect(low?.agreement.kind === "disagree" && low.agreement.adjudication?.verdict).toBe(
      "insufficient",
    );
    expect(result.telemetry.cappedFindingIds).toContain("LOW");
  });
});

// ── 2.2 Prompt content ────────────────────────────────────────────────────────

describe("runFindingAdjudication — prompt content (#41)", () => {
  it("carries both labelled answers with polarity and the real file window (not only the hunk)", async () => {
    let captured = "";
    const turn = turnByRef(
      { a1: { verdict: "supported", evidence: "e" } },
      { capture: (p) => (captured = p) },
    );
    await runFindingAdjudication({
      findings: [solo("S1")],
      manifest: MANIFEST,
      readFileWindow: readAll,
      runTurn: turn,
      adjudicatedBy: BY,
      budget: budget(),
    });
    expect(captured).toContain("Claude FLAGGED this claim:");
    expect(captured).toContain("Codex DID NOT FLAG this claim: no concern raised here");
    // The real window carries MORE than the offered hunk line.
    expect(captured).toContain("more real context than the hunk");
  });

  it("uses the injected turn (a fresh session), not either generating seat", async () => {
    const turn = vi.fn(turnByRef({ a1: { verdict: "supported", evidence: "e" } }));
    await runFindingAdjudication({
      findings: [solo("S1")],
      manifest: MANIFEST,
      readFileWindow: readAll,
      runTurn: turn,
      adjudicatedBy: BY,
      budget: budget(),
    });
    expect(turn).toHaveBeenCalledOnce();
    expect(turn.mock.calls[0]?.[0]).toContain("cross-harness adjudication");
  });
});

// ── 2.3 Honesty asymmetry — never a drop ──────────────────────────────────────

describe("runFindingAdjudication — honest insufficient, never a drop (#41)", () => {
  it.each([
    {
      name: "more than one emitted item",
      body: {
        adjudications: [
          { ref: "a1", verdict: "supported", evidence: "line 1 proves it" },
          { ref: "a1", verdict: "contradicted", evidence: "line 2 refutes it" },
        ],
      },
    },
    {
      name: "a verdict for the wrong reference",
      body: {
        adjudications: [{ ref: "a2", verdict: "supported", evidence: "line 1 proves it" }],
      },
    },
    {
      name: "empty evidence",
      body: { adjudications: [{ ref: "a1", verdict: "supported", evidence: "   " }] },
    },
  ])("stamps insufficient for $name", async ({ body }) => {
    const result = await runFindingAdjudication({
      findings: [solo("S1")],
      manifest: MANIFEST,
      readFileWindow: readAll,
      runTurn: async () => ({ status: "emitted", body }),
      adjudicatedBy: BY,
      budget: budget(),
    });

    const finding = result.findings[0];
    expect(finding?.agreement.kind === "disagree" && finding.agreement.adjudication?.verdict).toBe(
      "insufficient",
    );
  });

  it("a thrown/guarded turn stamps insufficient with the reason, keeps the row", async () => {
    const throwing: AdjudicationTurn = async () => {
      throw new Error("session spawn failed");
    };
    const result = await runFindingAdjudication({
      findings: [solo("S1")],
      manifest: MANIFEST,
      readFileWindow: readAll,
      runTurn: throwing,
      adjudicatedBy: BY,
      budget: budget(),
    });
    expect(result.findings).toHaveLength(1);
    const s = result.findings[0];
    expect(s?.agreement.kind === "disagree" && s.agreement.adjudication?.verdict).toBe(
      "insufficient",
    );
    expect(s?.agreement.kind === "disagree" && s.agreement.adjudication?.evidence).toMatch(
      /session spawn failed/,
    );
  });

  it("a failed turn stamps insufficient, never drops", async () => {
    const result = await runFindingAdjudication({
      findings: [solo("S1")],
      manifest: MANIFEST,
      readFileWindow: readAll,
      runTurn: turnByRef({}, { fail: "harness completed without structured output" }),
      adjudicatedBy: BY,
      budget: budget(),
    });
    const s = result.findings[0];
    expect(s?.agreement.kind === "disagree" && s.agreement.adjudication?.verdict).toBe(
      "insufficient",
    );
  });

  it("an exhausted budget stamps insufficient with the bound named, never drops", async () => {
    const zero = createInvocationBudget(0);
    const result = await runFindingAdjudication({
      findings: [solo("S1")],
      manifest: MANIFEST,
      readFileWindow: readAll,
      runTurn: turnByRef({ a1: { verdict: "supported", evidence: "e" } }),
      adjudicatedBy: BY,
      budget: zero,
    });
    const s = result.findings[0];
    expect(s?.agreement.kind === "disagree" && s.agreement.adjudication?.verdict).toBe(
      "insufficient",
    );
    expect(result.telemetry.budgetRefusedFindingIds).toContain("S1");
  });

  it("a contradicted verdict leaves the row present with both verbatim answers intact", async () => {
    const result = await runFindingAdjudication({
      findings: [solo("S1")],
      manifest: MANIFEST,
      readFileWindow: readAll,
      runTurn: turnByRef({
        a1: { verdict: "contradicted", evidence: "the guard at line 2 handles it" },
      }),
      adjudicatedBy: BY,
      budget: budget(),
    });
    const s = result.findings[0];
    expect(s?.agreement.kind).toBe("disagree");
    if (s?.agreement.kind !== "disagree") throw new Error("unreachable");
    expect(s.agreement.answers).toHaveLength(2);
    expect(s.agreement.answers[0]?.answer).toContain("load() can return null");
    expect(s.agreement.answers[1]?.answer).toBe("no concern raised here");
    expect(s.agreement.adjudication?.verdict).toBe("contradicted");
    expect(s.agreement.adjudication?.adjudicatedBy).toBe(BY);
  });

  it("never omits a contested row on any verdict (no drop path)", async () => {
    const findings = [solo("A"), solo("B", { anchor: "rennet:hunk/h2" }), concur("C")];
    const result = await runFindingAdjudication({
      findings,
      manifest: MANIFEST,
      readFileWindow: readAll,
      runTurn: turnByRef({
        a1: { verdict: "contradicted", evidence: "e" },
        a2: { verdict: "supported", evidence: "e" },
      }),
      adjudicatedBy: BY,
      budget: budget(),
    });
    expect(result.findings.map((f) => f.findingId)).toEqual(["A", "B", "C"]);
  });

  it("starts every budgeted adjudication turn concurrently", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: string[] = [];
    const runTurn: AdjudicationTurn = async (prompt) => {
      const finding = prompt.includes("return y.value") ? "B" : "A";
      started.push(finding);
      if (finding === "A") await firstBlocked;
      return {
        status: "emitted",
        body: { adjudications: [{ ref: "a1", verdict: "supported", evidence: "line 1" }] },
      };
    };

    const pending = runFindingAdjudication({
      findings: [solo("A"), solo("B", { anchor: "rennet:hunk/h2" })],
      manifest: MANIFEST,
      readFileWindow: readAll,
      runTurn,
      adjudicatedBy: BY,
      budget: budget(),
    });
    await vi.waitFor(() => expect(started).toEqual(["A", "B"]));
    releaseFirst?.();
    await expect(pending).resolves.toMatchObject({ telemetry: { adjudicationTurns: 2 } });
  });
});

describe("adjudicateFlaggedReview (#41)", () => {
  it("passes a failed review through untouched", async () => {
    const { review } = await adjudicateFlaggedReview(
      { status: "failed", reason: "boom" },
      {
        manifest: MANIFEST,
        readFileWindow: readAll,
        runTurn: turnByRef({}),
        adjudicatedBy: BY,
      },
    );
    expect(review.status).toBe("failed");
  });

  it("DEFAULT_MAX_ADJUDICATIONS is 4", () => {
    expect(DEFAULT_MAX_ADJUDICATIONS).toBe(4);
  });
});
