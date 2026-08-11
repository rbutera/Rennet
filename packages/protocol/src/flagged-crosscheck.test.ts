import type { FindingElement } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { parseCommandOutput } from "./index";

/**
 * The delivery check (Rule 80) for the predicted-risk cross-check (issue #181):
 * the `crossChecks` field MUST survive the `flagged.review` command boundary. The
 * ok branch is a strict `z.object`, so a field absent from the schema is silently
 * stripped by `.parse()` — which would make the anti-rubber-stamp payoff computed
 * in the live path but never reach the renderer. These tests prove it is carried
 * through, that a malformed cross-check is rejected (a real check that can go red),
 * and that a review WITHOUT it round-trips byte-identical to the pre-#181 shape.
 */

function finding(findingId: string, summary: string): FindingElement {
  return {
    findingId,
    anchor: "rennet:hunk/h1",
    summary,
    severity: "high",
    agreement: { kind: "concur", agree: 1, total: 1 },
  };
}

describe("flagged.review — crossChecks delivery across the command boundary (#181)", () => {
  it("carries confirmed + open crossChecks through the output schema (they reach the UI)", () => {
    const output = parseCommandOutput("flagged.review", {
      status: "ok",
      findings: [finding("f1", "store key derived per branch collides on repository root")],
      dual: { seats: ["Claude", "Codex"] },
      crossChecks: [
        { riskId: "r1", status: "confirmed", findingIds: ["f1"] },
        { riskId: "r2", status: "open", findingIds: [] },
      ],
    });
    if (output.status !== "ok") throw new Error("expected ok");
    expect(output.crossChecks).toEqual([
      { riskId: "r1", status: "confirmed", findingIds: ["f1"] },
      { riskId: "r2", status: "open", findingIds: [] },
    ]);
    // Existing fields are untouched — the field is purely additive.
    expect(output.dual).toEqual({ seats: ["Claude", "Codex"] });
    expect(output.findings).toHaveLength(1);
  });

  it("round-trips an ok review WITHOUT crossChecks unchanged (pre-#181 shape preserved)", () => {
    const output = parseCommandOutput("flagged.review", {
      status: "ok",
      findings: [finding("f1", "a concern")],
    });
    if (output.status !== "ok") throw new Error("expected ok");
    expect(output.crossChecks).toBeUndefined();
  });

  it("rejects a malformed cross-check status (positive control — the check can go red)", () => {
    expect(() =>
      parseCommandOutput("flagged.review", {
        status: "ok",
        findings: [finding("f1", "a concern")],
        // `status` is neither "confirmed" nor "open" → the enum must fail.
        crossChecks: [{ riskId: "r1", status: "maybe", findingIds: [] }],
      }),
    ).toThrow();
  });
});
