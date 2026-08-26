import type { FindingElement } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { buildFlaggedIndex } from "./flagged";

// The verification chip (#179) rides onto the flagged row, so the surface can render
// the evidence at the finding's anchor. Additive: an unverified finding's row simply
// omits it. A refuted finding never reaches the lens — core dropped it upstream — so
// the lens only ever renders `reproduced` (confirmed) or `inconclusive` (caveat).

function finding(overrides: Partial<FindingElement> & { findingId: string }): FindingElement {
  return {
    anchor: "rennet:hunk/h1",
    summary: "a value can be null and is dereferenced without a guard",
    severity: "high",
    agreement: { kind: "concur", agree: 1, total: 1 },
    ...overrides,
  };
}

describe("buildFlaggedIndex + verification chip (#179)", () => {
  it("carries a reproduced verification chip onto the row", () => {
    const index = buildFlaggedIndex({
      status: "ok",
      findings: [
        finding({
          findingId: "F1",
          verification: { verdict: "reproduced", evidence: "null at L1, deref at L2" },
        }),
      ],
    });
    expect(index.state).toBe("ok");
    if (index.state === "ok") {
      expect(index.rows[0]?.verification).toEqual({
        verdict: "reproduced",
        evidence: "null at L1, deref at L2",
      });
    }
  });

  it("carries an inconclusive caveat onto the row (surfaced, not hidden)", () => {
    const index = buildFlaggedIndex({
      status: "ok",
      findings: [
        finding({
          findingId: "F1",
          verification: { verdict: "inconclusive", evidence: "could not verify" },
        }),
      ],
    });
    if (index.state === "ok") expect(index.rows[0]?.verification?.verdict).toBe("inconclusive");
  });

  it("omits the chip on an unverified finding (unchanged row shape)", () => {
    const index = buildFlaggedIndex({ status: "ok", findings: [finding({ findingId: "F1" })] });
    if (index.state === "ok") expect(index.rows[0]?.verification).toBeUndefined();
  });

  it("ignores a malformed verification chip rather than crashing the lens", () => {
    const bad = finding({ findingId: "F1" });
    (bad as unknown as { verification: unknown }).verification = { verdict: "bogus", evidence: 5 };
    const index = buildFlaggedIndex({ status: "ok", findings: [bad] });
    if (index.state === "ok") expect(index.rows[0]?.verification).toBeUndefined();
  });
});
