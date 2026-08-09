import type { FindingElement, FlaggedReview } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { buildFlaggedIndex, isFinding } from "./flagged";

function finding(over: Partial<FindingElement> & Pick<FindingElement, "findingId">): FindingElement {
  return {
    anchor: `rennet:hunk/${over.findingId}`,
    summary: `Finding ${over.findingId}`,
    severity: "medium",
    agreement: { kind: "concur", agree: 3, total: 3 },
    ...over,
  };
}

function ok(findings: FindingElement[]): FlaggedReview {
  return { status: "ok", findings };
}

describe("buildFlaggedIndex — the flagged index derivation", () => {
  it("orders by severity high → medium → low, then by findingId", () => {
    const index = buildFlaggedIndex(
      ok([
        finding({ findingId: "b", severity: "low" }),
        finding({ findingId: "a", severity: "high" }),
        finding({ findingId: "z", severity: "medium" }),
        finding({ findingId: "a2", severity: "high" }),
      ]),
    );
    expect(index.state).toBe("ok");
    if (index.state !== "ok") throw new Error("expected ok");
    expect(index.rows.map((row) => row.findingId)).toEqual(["a", "a2", "z", "b"]);
    expect(index.rows.map((row) => row.severity)).toEqual(["high", "high", "medium", "low"]);
  });

  it("is a pure function of the finding SET — input order does not matter", () => {
    const a = finding({ findingId: "a", severity: "high" });
    const b = finding({ findingId: "b", severity: "medium" });
    const c = finding({ findingId: "c", severity: "low" });
    const forward = buildFlaggedIndex(ok([a, b, c]));
    const reversed = buildFlaggedIndex(ok([c, b, a]));
    expect(forward).toEqual(reversed);
  });

  it("carries the concur vote counts through (both models concur 3/3)", () => {
    const index = buildFlaggedIndex(
      ok([finding({ findingId: "x", agreement: { kind: "concur", agree: 3, total: 3 } })]),
    );
    if (index.state !== "ok") throw new Error("expected ok");
    expect(index.rows[0]?.agreement).toEqual({ kind: "concur", agree: 3, total: 3 });
  });

  it("carries a disagreement's per-model answers side by side, labelled", () => {
    const index = buildFlaggedIndex(
      ok([
        finding({
          findingId: "x",
          agreement: {
            kind: "disagree",
            answers: [
              { model: "Claude", answer: "This leaks the handle" },
              { model: "Codex", answer: "The handle is closed in the finally" },
            ],
          },
        }),
      ]),
    );
    if (index.state !== "ok") throw new Error("expected ok");
    const agreement = index.rows[0]?.agreement;
    expect(agreement?.kind).toBe("disagree");
    if (agreement?.kind !== "disagree") throw new Error("expected disagree");
    expect(agreement.answers.map((a) => a.model)).toEqual(["Claude", "Codex"]);
    expect(agreement.answers[0]?.answer).toContain("leaks");
  });

  it("counts per severity for the header chips", () => {
    const index = buildFlaggedIndex(
      ok([
        finding({ findingId: "a", severity: "high" }),
        finding({ findingId: "b", severity: "high" }),
        finding({ findingId: "c", severity: "low" }),
      ]),
    );
    if (index.state !== "ok") throw new Error("expected ok");
    expect(index.counts).toEqual({ high: 2, medium: 0, low: 1 });
    expect(index.total).toBe(3);
  });

  // The load-bearing distinction: a review that RAN and flagged nothing is a
  // different state from a runner that FAILED. The lens must render them apart.
  it("a review with no findings is honestly EMPTY (ok, zero rows), not failed", () => {
    const index = buildFlaggedIndex(ok([]));
    expect(index.state).toBe("ok");
    if (index.state !== "ok") throw new Error("expected ok");
    expect(index.rows).toEqual([]);
    expect(index.total).toBe(0);
  });

  it("a failed runner is a DISTINCT state carrying its reason, never 'no findings'", () => {
    const index = buildFlaggedIndex({ status: "failed", reason: "harness timed out" });
    expect(index.state).toBe("failed");
    if (index.state !== "failed") throw new Error("expected failed");
    expect(index.reason).toBe("harness timed out");
  });

  // Acceptance criterion: validator rejections NEVER appear as flags (grep + test).
  it("NEVER surfaces a validator rejection / malformed item as a flag", () => {
    // A `rejectedItems` entry is shaped nothing like a finding — no severity, no
    // agreement, a rejection reason instead of a summary. It must be dropped.
    const rejected = {
      docType: "finding",
      rejectionReason: "schema: missing required field 'severity'",
      raw: { anchor: "rennet:hunk/9", note: "the model tried to emit this" },
    } as unknown as FindingElement;
    const good = finding({ findingId: "real", severity: "high" });
    const index = buildFlaggedIndex(ok([rejected, good]));
    if (index.state !== "ok") throw new Error("expected ok");
    expect(index.rows).toHaveLength(1);
    expect(index.rows[0]?.findingId).toBe("real");
  });

  it("drops findings with a malformed agreement (guard is strict on the whole shape)", () => {
    const bad = {
      findingId: "bad",
      anchor: "rennet:hunk/1",
      summary: "looks like a finding but the agreement is junk",
      severity: "high",
      agreement: { kind: "maybe" },
    } as unknown as FindingElement;
    const index = buildFlaggedIndex(ok([bad]));
    if (index.state !== "ok") throw new Error("expected ok");
    expect(index.rows).toEqual([]);
  });
});

describe("isFinding — the strict flag guard", () => {
  it("accepts a well-formed finding", () => {
    expect(isFinding(finding({ findingId: "x" }))).toBe(true);
  });

  it("rejects a validator-rejection-shaped object", () => {
    expect(isFinding({ rejectionReason: "bad", raw: {} })).toBe(false);
  });

  it("rejects null, non-objects, and partial findings", () => {
    expect(isFinding(null)).toBe(false);
    expect(isFinding("finding")).toBe(false);
    expect(isFinding({ findingId: "x", anchor: "a", summary: "s", severity: "urgent" })).toBe(false);
  });
});
