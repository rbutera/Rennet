import type { FindingElement, FlaggedReview, OfferedManifest, RspTokenUsage } from "@rennet/types";
import { describe, expect, it } from "vitest";
import {
  classifyNonObvious,
  DEFAULT_MAX_VERIFICATIONS,
  describeVerificationCost,
  markVerificationUnavailable,
  runFindingVerification,
  VERIFIER_UNAVAILABLE_CAVEAT,
  type VerificationFileReader,
  type VerificationFileWindow,
  type VerificationTurn,
  type VerificationTurnResult,
  verifyFlaggedReview,
} from "./finding-verification";
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

function finding(overrides: Partial<FindingElement> & { findingId: string }): FindingElement {
  return {
    anchor: "rennet:hunk/h1",
    summary: "a value can be null and is dereferenced without a guard",
    severity: "high",
    agreement: { kind: "concur", agree: 1, total: 1 },
    ...overrides,
  };
}

const WINDOWS: Record<string, VerificationFileWindow> = {
  "rennet:hunk/h1": { path: "a.ts", startLine: 1, endLine: 5, text: "const x = load();\nuse(x);" },
  "rennet:hunk/h2": { path: "a.ts", startLine: 20, endLine: 24, text: "return y.value;" },
  "rennet:hunk/h3": { path: "b.ts", startLine: 1, endLine: 3, text: "race();" },
};

const readAll: VerificationFileReader = async (anchor) => WINDOWS[anchor];

/** A turn that returns a verdict per finding, keyed by the concern summary in the prompt. */
function turnBySummary(
  verdicts: Record<string, { verdict: string; evidence: string }>,
  opts: { fail?: string; tokens?: RspTokenUsage } = {},
): VerificationTurn {
  return async (prompt: string): Promise<VerificationTurnResult> => {
    if (opts.fail) return { status: "failed", message: opts.fail };
    const verifications: { ref: string; verdict: string; evidence: string }[] = [];
    const re = /### (f\d+)[^\n]*\nConcern: (.+)/g;
    let match: RegExpExecArray | null = re.exec(prompt);
    while (match !== null) {
      const ref = match[1] as string;
      const summary = match[2] as string;
      const verdict = verdicts[summary];
      if (verdict) verifications.push({ ref, ...verdict });
      match = re.exec(prompt);
    }
    return {
      status: "emitted",
      body: { verifications },
      ...(opts.tokens ? { tokens: opts.tokens } : {}),
    };
  };
}

const budget = () => createInvocationBudget(10);

// ── ① classifyNonObvious ───────────────────────────────────────────────────────

describe("classifyNonObvious (#179)", () => {
  it("verifies a high/medium behavioural claim", () => {
    expect(classifyNonObvious(finding({ findingId: "F", severity: "high" }))).toBe(true);
    expect(classifyNonObvious(finding({ findingId: "F", severity: "medium" }))).toBe(true);
  });

  it("skips a low-severity nit (surfaces directly, no verification)", () => {
    expect(classifyNonObvious(finding({ findingId: "F", severity: "low" }))).toBe(false);
  });

  it("skips a mechanical claim even at high severity (the floor already settles it)", () => {
    expect(
      classifyNonObvious(
        finding({ findingId: "F", severity: "high", summary: "this import is now unused" }),
      ),
    ).toBe(false);
    expect(
      classifyNonObvious(
        finding({ findingId: "F", severity: "medium", summary: "a typo in the comment" }),
      ),
    ).toBe(false);
  });
});

// ── ② runFindingVerification: disposition ───────────────────────────────────────

describe("runFindingVerification disposition (#179)", () => {
  it("attaches the evidence chip to a REPRODUCED finding", async () => {
    const f = finding({ findingId: "F1" });
    const result = await runFindingVerification({
      findings: [f],
      manifest: MANIFEST,
      readFileWindow: readAll,
      runTurn: turnBySummary({
        [f.summary]: { verdict: "reproduced", evidence: "null at L1, deref at L2" },
      }),
      budget: budget(),
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.verification).toEqual({
      verdict: "reproduced",
      evidence: "null at L1, deref at L2",
    });
    expect(result.telemetry.reproduced).toBe(1);
  });

  it("DROPS a refuted finding — it never reaches the surfaced set", async () => {
    const keep = finding({ findingId: "F1", anchor: "rennet:hunk/h1", summary: "real null deref" });
    const refuted = finding({
      findingId: "F2",
      anchor: "rennet:hunk/h3",
      summary: "hallucinated bug",
    });
    const result = await runFindingVerification({
      findings: [keep, refuted],
      manifest: MANIFEST,
      readFileWindow: readAll,
      runTurn: turnBySummary({
        "real null deref": { verdict: "reproduced", evidence: "L2 dereferences a null" },
        "hallucinated bug": { verdict: "refuted", evidence: "the guard on L3 makes this safe" },
      }),
      budget: budget(),
    });
    expect(result.findings.map((finding) => finding.findingId)).toEqual(["F1"]);
    expect(result.findings.some((finding) => finding.findingId === "F2")).toBe(false);
    expect(result.telemetry.refuted).toBe(1);
    expect(result.telemetry.reproduced).toBe(1);
  });

  it("surfaces an INCONCLUSIVE finding WITH a caveat, never dropped", async () => {
    const f = finding({ findingId: "F1" });
    const result = await runFindingVerification({
      findings: [f],
      manifest: MANIFEST,
      readFileWindow: readAll,
      runTurn: turnBySummary({
        [f.summary]: { verdict: "inconclusive", evidence: "cannot trace the caller" },
      }),
      budget: budget(),
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.verification).toEqual({
      verdict: "inconclusive",
      evidence: "cannot trace the caller",
    });
    expect(result.telemetry.inconclusive).toBe(1);
  });

  it("treats a REPRODUCED verdict with no evidence as inconclusive (a guess is not proof)", async () => {
    const f = finding({ findingId: "F1" });
    const result = await runFindingVerification({
      findings: [f],
      manifest: MANIFEST,
      readFileWindow: readAll,
      runTurn: turnBySummary({ [f.summary]: { verdict: "reproduced", evidence: "  " } }),
      budget: budget(),
    });
    expect(result.findings[0]?.verification?.verdict).toBe("inconclusive");
    expect(result.telemetry.reproduced).toBe(0);
  });

  it("passes an OBVIOUS finding through unchanged (no verification, no turn)", async () => {
    const low = finding({ findingId: "F1", severity: "low", summary: "minor style nit" });
    const result = await runFindingVerification({
      findings: [low],
      manifest: MANIFEST,
      readFileWindow: readAll,
      runTurn: turnBySummary({}),
      budget: budget(),
    });
    expect(result.findings[0]?.verification).toBeUndefined();
    expect(result.telemetry.verificationTurns).toBe(0);
    expect(result.telemetry.candidates).toBe(0);
  });

  it("caveats a finding whose real file content is UNAVAILABLE (never a clear)", async () => {
    const f = finding({ findingId: "F1", anchor: "rennet:hunk/h1" });
    const reader: VerificationFileReader = async () => undefined;
    const result = await runFindingVerification({
      findings: [f],
      manifest: MANIFEST,
      readFileWindow: reader,
      runTurn: turnBySummary({ [f.summary]: { verdict: "refuted", evidence: "n/a" } }),
      budget: budget(),
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.verification?.verdict).toBe("inconclusive");
    expect(result.telemetry.verificationTurns).toBe(0);
  });
});

// ── ② executed reproduction: proof it RAN, not just re-read (#259) ───────────────

describe("runFindingVerification executed reproduction (#259)", () => {
  /** A turn that returns one verdict AND (optionally) the commands it actually ran. */
  function turnWith(
    verdict: { verdict: string; evidence: string },
    execution?: { commands: { command: string; ok: boolean; outputTail: string }[] },
  ): VerificationTurn {
    return async (): Promise<VerificationTurnResult> => ({
      status: "emitted",
      body: {
        verifications: [{ ref: "f1", verdict: verdict.verdict, evidence: verdict.evidence }],
      },
      ...(execution ? { execution } : {}),
    });
  }

  it("a reproduced verdict backed by a command the turn RAN counts as reproduced-by-execution", async () => {
    const f = finding({ findingId: "F1" });
    const result = await runFindingVerification({
      findings: [f],
      manifest: MANIFEST,
      readFileWindow: readAll,
      runTurn: turnWith(
        { verdict: "reproduced", evidence: "ran the test — it threw on empty input" },
        { commands: [{ command: "pnpm vitest run a.test.ts", ok: false, outputTail: "1 failed" }] },
      ),
      budget: budget(),
    });
    expect(result.findings[0]?.verification?.verdict).toBe("reproduced");
    expect(result.telemetry.commandsRun).toBe(1);
    expect(result.telemetry.reproducedByExecution).toBe(1);
  });

  it("a reproduced verdict from a turn that ran NOTHING is reproduced-by-reading, not by execution", async () => {
    // Same verdict, same finding: the ONLY difference is whether a command executed —
    // and that is exactly what the telemetry keeps apart, so "reproduced" can never
    // silently mean "a model re-read it and still believed itself."
    const f = finding({ findingId: "F1" });
    const result = await runFindingVerification({
      findings: [f],
      manifest: MANIFEST,
      readFileWindow: readAll,
      runTurn: turnWith({ verdict: "reproduced", evidence: "line 2 dereferences a null x" }),
      budget: budget(),
    });
    expect(result.findings[0]?.verification?.verdict).toBe("reproduced");
    expect(result.telemetry.commandsRun).toBe(0);
    expect(result.telemetry.reproducedByExecution).toBe(0);
  });

  it("counts commandsRun even when a run ends inconclusive, but not reproducedByExecution", async () => {
    const f = finding({ findingId: "F1" });
    const result = await runFindingVerification({
      findings: [f],
      manifest: MANIFEST,
      readFileWindow: readAll,
      runTurn: turnWith(
        { verdict: "inconclusive", evidence: "the test harness would not build here" },
        { commands: [{ command: "pnpm build", ok: false, outputTail: "error" }] },
      ),
      budget: budget(),
    });
    expect(result.telemetry.commandsRun).toBe(1);
    expect(result.telemetry.reproducedByExecution).toBe(0);
  });
});

// ── ② cost containment: cap + batching + budget ─────────────────────────────────

describe("runFindingVerification cost containment (#179)", () => {
  it("caps at maxVerifications: top-K by severity verified, the rest surface caveated", async () => {
    const findings = [
      finding({ findingId: "F1", anchor: "rennet:hunk/h1", severity: "high", summary: "high one" }),
      finding({ findingId: "F2", anchor: "rennet:hunk/h2", severity: "high", summary: "high two" }),
      finding({
        findingId: "F3",
        anchor: "rennet:hunk/h3",
        severity: "medium",
        summary: "medium three",
      }),
    ];
    const result = await runFindingVerification({
      findings,
      manifest: MANIFEST,
      readFileWindow: readAll,
      runTurn: turnBySummary({
        "high one": { verdict: "reproduced", evidence: "proof a" },
        "high two": { verdict: "reproduced", evidence: "proof b" },
        "medium three": { verdict: "reproduced", evidence: "proof c" },
      }),
      budget: budget(),
      maxVerifications: 2,
    });
    // The medium finding is beyond the cap → surfaced with a "not verified" caveat.
    const byId = new Map(result.findings.map((f) => [f.findingId, f]));
    expect(byId.get("F1")?.verification?.verdict).toBe("reproduced");
    expect(byId.get("F2")?.verification?.verdict).toBe("reproduced");
    expect(byId.get("F3")?.verification?.verdict).toBe("inconclusive");
    expect(result.telemetry.cappedFindingIds).toEqual(["F3"]);
    expect(byId.get("F3")?.verification?.evidence.toLowerCase()).toContain("not verified");
  });

  it("BATCHES findings that share a file into ONE turn", async () => {
    let turns = 0;
    const counting: VerificationTurn = async (prompt) => {
      turns += 1;
      const inner = turnBySummary({
        "same file a": { verdict: "reproduced", evidence: "e1" },
        "same file b": { verdict: "reproduced", evidence: "e2" },
        "other file": { verdict: "reproduced", evidence: "e3" },
      });
      return inner(prompt);
    };
    const result = await runFindingVerification({
      findings: [
        finding({ findingId: "F1", anchor: "rennet:hunk/h1", summary: "same file a" }), // a.ts
        finding({ findingId: "F2", anchor: "rennet:hunk/h2", summary: "same file b" }), // a.ts
        finding({ findingId: "F3", anchor: "rennet:hunk/h3", summary: "other file" }), // b.ts
      ],
      manifest: MANIFEST,
      readFileWindow: readAll,
      runTurn: counting,
      budget: budget(),
    });
    // Two files → two turns (not three), and all three findings got a verdict.
    expect(turns).toBe(2);
    expect(result.telemetry.verificationTurns).toBe(2);
    expect(result.telemetry.verifiedFindings).toBe(3);
  });

  it("sums the tokens spent across verification turns (the cost line)", async () => {
    const tokens: RspTokenUsage = {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: null,
      total: 120,
    };
    const f = finding({ findingId: "F1" });
    const result = await runFindingVerification({
      findings: [f],
      manifest: MANIFEST,
      readFileWindow: readAll,
      runTurn: turnBySummary({ [f.summary]: { verdict: "reproduced", evidence: "e" } }, { tokens }),
      budget: budget(),
    });
    expect(result.telemetry.tokensSpent?.total).toBe(120);
    expect(describeVerificationCost(result.telemetry)).toContain("+1 turn");
    expect(describeVerificationCost(result.telemetry, 294000)).toContain(
      "% of the 294000-token baseline",
    );
  });
});

// ── Red-then-green invariants ───────────────────────────────────────────────────

describe("runFindingVerification fail-closed invariants (#179)", () => {
  it("an ABSENT budget runs the verification turn UNGATED (#260) — a refuted finding drops normally", async () => {
    // #260 inverts the #95 fail-closed default: no budget means no ceiling, so the
    // verification turn RUNS. F1 is refuted → dropped, exactly as it would be with a
    // budget in hand — no fabricated "not verified" caveat, no budget-refused id.
    const f = finding({ findingId: "F1" });
    const result = await runFindingVerification({
      findings: [f],
      manifest: MANIFEST,
      readFileWindow: readAll,
      runTurn: turnBySummary({ [f.summary]: { verdict: "refuted", evidence: "n/a" } }),
      // budget omitted — no ceiling, the turn runs.
    });
    expect(result.telemetry.verificationTurns).toBe(1);
    expect(result.findings).toHaveLength(0);
    expect(result.telemetry.budgetRefusedFindingIds).toEqual([]);
  });

  it("a failed verification turn caveats the batch, never drops it", async () => {
    const f = finding({ findingId: "F1" });
    const result = await runFindingVerification({
      findings: [f],
      manifest: MANIFEST,
      readFileWindow: readAll,
      runTurn: turnBySummary({}, { fail: "codex flaked" }),
      budget: budget(),
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.verification?.verdict).toBe("inconclusive");
    expect(result.findings[0]?.verification?.evidence).toContain("codex flaked");
  });

  it("preserves the ORIGINAL finding order (minus drops)", async () => {
    const findings = [
      finding({ findingId: "F1", anchor: "rennet:hunk/h1", summary: "keep first" }),
      finding({ findingId: "F2", anchor: "rennet:hunk/h2", summary: "drop me" }),
      finding({ findingId: "F3", anchor: "rennet:hunk/h3", summary: "keep last" }),
    ];
    const result = await runFindingVerification({
      findings,
      manifest: MANIFEST,
      readFileWindow: readAll,
      runTurn: turnBySummary({
        "keep first": { verdict: "reproduced", evidence: "a" },
        "drop me": { verdict: "refuted", evidence: "b" },
        "keep last": { verdict: "inconclusive", evidence: "c" },
      }),
      budget: budget(),
    });
    expect(result.findings.map((f) => f.findingId)).toEqual(["F1", "F3"]);
  });
});

// ── verifyFlaggedReview composition ─────────────────────────────────────────────

describe("verifyFlaggedReview (#179)", () => {
  it("passes a FAILED review through untouched", async () => {
    const { review, telemetry } = await verifyFlaggedReview(
      { status: "failed", reason: "runner did not complete" },
      { manifest: MANIFEST, readFileWindow: readAll, runTurn: turnBySummary({}), budget: budget() },
    );
    expect(review).toEqual({ status: "failed", reason: "runner did not complete" });
    expect(telemetry.verificationTurns).toBe(0);
  });

  it("verifies an OK review, dropping refuted findings and keeping the dual note", async () => {
    const { review } = await verifyFlaggedReview(
      {
        status: "ok",
        findings: [
          finding({ findingId: "F1", anchor: "rennet:hunk/h1", summary: "keep" }),
          finding({ findingId: "F2", anchor: "rennet:hunk/h3", summary: "drop" }),
        ],
        dual: { seats: ["Claude", "Codex"] },
      },
      {
        manifest: MANIFEST,
        readFileWindow: readAll,
        runTurn: turnBySummary({
          keep: { verdict: "reproduced", evidence: "e" },
          drop: { verdict: "refuted", evidence: "safe" },
        }),
        budget: budget(),
      },
    );
    expect(review.status).toBe("ok");
    if (review.status === "ok") {
      expect(review.findings.map((f) => f.findingId)).toEqual(["F1"]);
      expect(review.dual).toEqual({ seats: ["Claude", "Codex"] });
    }
  });
});

describe("DEFAULT_MAX_VERIFICATIONS", () => {
  it("is a sane positive cap", () => {
    expect(DEFAULT_MAX_VERIFICATIONS).toBeGreaterThan(0);
  });
});

describe("markVerificationUnavailable — deep review with no verifier (#179 P0-3)", () => {
  const ok = (findings: FindingElement[]): FlaggedReview => ({ status: "ok", findings });

  it("stamps an inconclusive 'verification unavailable' caveat on a non-obvious finding", () => {
    // A Codex-only deep review produced this behavioural finding, but no Claude verifier
    // ran — so it must carry an HONEST caveat, never surface chip-less (reading as an
    // all-clear) while deep review appears active.
    const result = markVerificationUnavailable(
      ok([finding({ findingId: "F1", severity: "high" })]),
    );
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.findings[0]?.verification).toEqual({
      verdict: "inconclusive",
      evidence: VERIFIER_UNAVAILABLE_CAVEAT,
    });
  });

  it("leaves an OBVIOUS finding chip-less (never over-marks — matches the verified path)", () => {
    // Low severity and mechanical claims never pay for a verification turn, so an absent
    // chip is honest for them; the caveat is only for findings that WOULD have verified.
    const result = markVerificationUnavailable(
      ok([
        finding({ findingId: "low", severity: "low" }),
        finding({ findingId: "mech", severity: "high", summary: "this import is now unused" }),
      ]),
    );
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.findings[0]?.verification).toBeUndefined();
    expect(result.findings[1]?.verification).toBeUndefined();
  });

  it("leaves a finding that ALREADY carries a chip untouched", () => {
    const already = finding({
      findingId: "F1",
      severity: "high",
      verification: { verdict: "reproduced", evidence: "we dug into it" },
    });
    const result = markVerificationUnavailable(ok([already]));
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.findings[0]?.verification).toEqual({
      verdict: "reproduced",
      evidence: "we dug into it",
    });
  });

  it("passes a FAILED review through unchanged", () => {
    const failed: FlaggedReview = { status: "failed", reason: "both seats down" };
    expect(markVerificationUnavailable(failed)).toBe(failed);
  });
});
