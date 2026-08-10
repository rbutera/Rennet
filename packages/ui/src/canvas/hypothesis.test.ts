import type { FindingSeverity, ReviewHypothesis, RiskCrossCheck } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { buildHypothesisFrame } from "./hypothesis";

function risk(riskId: string, severity: FindingSeverity): ReviewHypothesis["risks"][number] {
  return { riskId, statement: `s-${riskId}`, severity, disconfirmer: `d-${riskId}` };
}

function hypothesis(risks: ReviewHypothesis["risks"], repoContextPresent = true): ReviewHypothesis {
  return {
    domain: "the domain",
    scope: { inScope: ["a"], outOfScope: ["b"] },
    designExpectation: "the design",
    risks,
    repoContextPresent,
  };
}

describe("buildHypothesisFrame — the reading frame (#178)", () => {
  it("orders by severity, then OPEN before confirmed within a severity, then riskId", () => {
    const h = hypothesis([
      risk("r-high-confirmed", "high"),
      risk("r-high-open", "high"),
      risk("r-low-open", "low"),
      risk("r-medium-open", "medium"),
    ]);
    const crossChecks: RiskCrossCheck[] = [
      { riskId: "r-high-confirmed", status: "confirmed", findingIds: ["f1"] },
    ];
    const frame = buildHypothesisFrame(h, crossChecks);
    expect(frame.risks.map((r) => r.riskId)).toEqual([
      "r-high-open", // high, open first
      "r-high-confirmed", // high, confirmed after open
      "r-medium-open",
      "r-low-open",
    ]);
  });

  it("confirms a risk with a matching cross-check and links its findings", () => {
    const frame = buildHypothesisFrame(hypothesis([risk("r1", "high")]), [
      { riskId: "r1", status: "confirmed", findingIds: ["f1", "f2"] },
    ]);
    expect(frame.risks[0]?.status).toBe("confirmed");
    expect(frame.risks[0]?.findingIds).toEqual(["f1", "f2"]);
    expect(frame.counts).toEqual({ confirmed: 1, open: 0 });
  });

  it("defaults a risk with no cross-check to OPEN (never a fabricated confirmed)", () => {
    const frame = buildHypothesisFrame(hypothesis([risk("r1", "high")]), []);
    expect(frame.risks[0]?.status).toBe("open");
    expect(frame.risks[0]?.findingIds).toEqual([]);
    expect(frame.counts).toEqual({ confirmed: 0, open: 1 });
  });

  it("carries the domain, scope, design, and repo-context flag through", () => {
    const frame = buildHypothesisFrame(hypothesis([risk("r1", "low")], false), []);
    expect(frame.domain).toBe("the domain");
    expect(frame.scope).toEqual({ inScope: ["a"], outOfScope: ["b"] });
    expect(frame.designExpectation).toBe("the design");
    expect(frame.repoContextPresent).toBe(false);
  });
});
