import type { FindingElement, FlaggedReview, ReviewHypothesis } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { attachRiskCrossCheck, crossCheckRisks, salientTokens } from "./risk-crosscheck";

function risk(
  riskId: string,
  statement: string,
  disconfirmer: string,
): ReviewHypothesis["risks"][number] {
  return { riskId, statement, severity: "high", disconfirmer };
}

function finding(findingId: string, summary: string): FindingElement {
  return {
    findingId,
    anchor: "rennet:hunk/h1",
    summary,
    severity: "high",
    agreement: { kind: "concur", agree: 1, total: 1 },
  };
}

const HYPOTHESIS = (risks: ReviewHypothesis["risks"]): ReviewHypothesis => ({
  domain: "d",
  scope: { inScope: [], outOfScope: [] },
  designExpectation: "e",
  risks,
  repoContextPresent: true,
});

describe("crossCheckRisks — the predicted-risk cross-check (issue #181)", () => {
  it("confirms a predicted-and-found risk and links the finding", () => {
    const hypothesis = HYPOTHESIS([
      risk(
        "r1",
        "the store key is computed per branch instead of per repository root",
        "check keying",
      ),
    ]);
    const findings = [
      finding(
        "f1",
        "store key is derived per branch, so worktrees collide on the repository entry",
      ),
    ];
    const result = crossCheckRisks(hypothesis, findings);
    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe("confirmed");
    expect(result[0]?.findingIds).toEqual(["f1"]);
  });

  it("marks a predicted-but-unflagged risk OPEN — surfaced, never dropped", () => {
    const hypothesis = HYPOTHESIS([
      risk(
        "r1",
        "a race between the watcher and the snapshot generator corrupts the shard",
        "check locking",
      ),
    ]);
    const findings = [finding("f1", "an unrelated concern about lockfile churn in the manifest")];
    const result = crossCheckRisks(hypothesis, findings);
    expect(result[0]?.status).toBe("open");
    expect(result[0]?.findingIds).toEqual([]);
  });

  it("is conservative — an incidental single-word overlap is NOT a match (bias toward open)", () => {
    const hypothesis = HYPOTHESIS([
      risk(
        "r1",
        "the migration drops the projectSnapshotId column prematurely",
        "check migration order",
      ),
    ]);
    // Shares only "migration" (one salient token) → below the 2-token floor → open.
    const findings = [finding("f1", "the migration comment has a typo")];
    const result = crossCheckRisks(hypothesis, findings);
    expect(result[0]?.status).toBe("open");
  });

  it("accounts for every risk exactly once, in order (totality — no risk dropped)", () => {
    const hypothesis = HYPOTHESIS([
      risk("r1", "alpha bravo charlie delta echo", "d1"),
      risk("r2", "foxtrot golf hotel india juliet", "d2"),
      risk("r3", "kilo lima mike november oscar", "d3"),
    ]);
    const result = crossCheckRisks(hypothesis, []);
    expect(result.map((r) => r.riskId)).toEqual(["r1", "r2", "r3"]);
    expect(result.every((r) => r.status === "open")).toBe(true);
  });
});

describe("attachRiskCrossCheck — the live-path composition point (issue #181)", () => {
  const okReview = (findings: FindingElement[], dual?: FlaggedReview): FlaggedReview => ({
    status: "ok",
    findings,
    ...(dual && dual.status === "ok" && dual.dual ? { dual: dual.dual } : {}),
  });

  it("surfaces confirmed AND open crossChecks onto an ok review's FINAL findings", () => {
    const hypothesis = HYPOTHESIS([
      risk(
        "r1",
        "the store key is computed per branch instead of per repository root",
        "check keying",
      ),
      risk("r2", "the migration drops a column without a backfill step", "check migration"),
    ]);
    const review = okReview([
      finding("f1", "store key derived per branch, so worktrees collide on the repository entry"),
    ]);
    const result = attachRiskCrossCheck(review, hypothesis);
    if (result.status !== "ok") throw new Error("expected ok");
    // The covered risk is confirmed and links the real finding id; the uncovered one
    // is the OPEN gap the human must check themselves — surfaced, never dropped.
    const byRisk = new Map(result.crossChecks?.map((c) => [c.riskId, c]));
    expect(byRisk.get("r1")?.status).toBe("confirmed");
    expect(byRisk.get("r1")?.findingIds).toEqual(["f1"]);
    expect(byRisk.get("r2")?.status).toBe("open");
    expect(byRisk.get("r2")?.findingIds).toEqual([]);
  });

  it("returns the review UNCHANGED when NO hypothesis was produced (no field invented)", () => {
    const review = okReview([finding("f1", "some concern")]);
    const result = attachRiskCrossCheck(review, undefined);
    expect(result).toBe(review); // referentially identical — byte-identical pre-#181 shape
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.crossChecks).toBeUndefined();
  });

  it("passes a FAILED review through untouched (nothing to cross-check)", () => {
    const failed: FlaggedReview = { status: "failed", reason: "both seats down" };
    const hypothesis = HYPOTHESIS([risk("r1", "a risk", "d1")]);
    expect(attachRiskCrossCheck(failed, hypothesis)).toBe(failed);
  });

  it("yields an EMPTY crossChecks for a hypothesis with no risks (honest 'nothing predicted')", () => {
    const result = attachRiskCrossCheck(okReview([finding("f1", "x")]), HYPOTHESIS([]));
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.crossChecks).toEqual([]);
  });

  it("carries the hypothesis alongside the crossChecks (issue #178: they must travel together)", () => {
    const hypothesis = HYPOTHESIS([
      risk("r1", "the store key is keyed per branch not per repository root", "check keying"),
    ]);
    const result = attachRiskCrossCheck(okReview([finding("f1", "unrelated concern")]), hypothesis);
    if (result.status !== "ok") throw new Error("expected ok");
    // The reading frame is folded from THIS hypothesis + THESE crossChecks, and the
    // crossChecks reference the hypothesis's per-pass riskIds — so both ride the review.
    expect(result.hypothesis).toBe(hypothesis);
    expect(result.crossChecks?.map((c) => c.riskId)).toEqual(["r1"]);
  });

  it("preserves the dual note while adding crossChecks (additive, existing fields intact)", () => {
    const review: FlaggedReview = {
      status: "ok",
      findings: [finding("f1", "store key derived per branch collides on repository root")],
      dual: { seats: ["Claude", "Codex"] },
    };
    const hypothesis = HYPOTHESIS([
      risk("r1", "the store key is keyed per branch not per repository root", "check keying"),
    ]);
    const result = attachRiskCrossCheck(review, hypothesis);
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.dual).toEqual({ seats: ["Claude", "Codex"] });
    expect(result.crossChecks?.[0]?.status).toBe("confirmed");
  });
});

describe("salientTokens", () => {
  it("keeps meaningful words and drops stopwords + short fragments", () => {
    const tokens = salientTokens("the change should verify the repository keying");
    expect(tokens.has("repository")).toBe(true);
    expect(tokens.has("keying")).toBe(true);
    // stopwords / short tokens dropped
    expect(tokens.has("the")).toBe(false);
    expect(tokens.has("change")).toBe(false);
    expect(tokens.has("should")).toBe(false);
  });
});
