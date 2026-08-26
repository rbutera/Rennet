import { describe, expect, it } from "vitest";
import type { FindingElement, ReviewHypothesis } from "./index";
import { parseCommandOutput } from "./index";

/**
 * The delivery check (Rule 80) for two fields that MUST survive the `flagged.review`
 * command boundary:
 *   • `verification` on each finding (issue #179) — the reproduce-or-refute chip;
 *   • `hypothesis` on the ok review (issue #178) — the reader's reading frame.
 *
 * The ok branch is a strict `z.object`, and each finding is a strict `z.object`, so a
 * field absent from the schema is silently stripped by `.parse()`. Before this
 * change, `findingElementSchema` omitted `verification` — so the evidence the
 * verification pass computed rode `FindingElement` in-process but was dropped at the
 * IPC boundary and NEVER reached the row. These tests prove both fields are carried,
 * that a malformed shape is rejected (a real check that can go red), and that a review
 * without them round-trips byte-identical to the pre-#178/#179 shape.
 */

function finding(overrides: Partial<FindingElement> & { findingId: string }): FindingElement {
  return {
    anchor: "rennet:hunk/h1",
    summary: "load() can return null and the result is dereferenced without a guard",
    severity: "high",
    agreement: { kind: "concur", agree: 1, total: 1 },
    ...overrides,
  };
}

const HYPOTHESIS: ReviewHypothesis = {
  domain: "per-org rate limiting",
  scope: { inScope: ["the token bucket"], outOfScope: ["the metrics registry"] },
  designExpectation: "one refill-on-read bucket per org, behind a RateStore interface",
  risks: [
    {
      riskId: "R1",
      statement: "an unbounded fail-open lets any org scrape during a store outage",
      severity: "high",
      disconfirmer: "check the fail-open bound",
    },
  ],
  repoContextPresent: true,
};

describe("flagged.review — verification chip delivery across the boundary (#179)", () => {
  it("carries a reproduced verification chip through the output (it reaches the row)", () => {
    const output = parseCommandOutput("flagged.review", {
      status: "ok",
      findings: [
        finding({
          findingId: "f1",
          verification: { verdict: "reproduced", evidence: "null at L12, deref at L14" },
        }),
      ],
    });
    if (output.status !== "ok") throw new Error("expected ok");
    expect(output.findings[0]?.verification).toEqual({
      verdict: "reproduced",
      evidence: "null at L12, deref at L14",
    });
  });

  it("carries an inconclusive caveat through the output (surfaced, never dropped)", () => {
    const output = parseCommandOutput("flagged.review", {
      status: "ok",
      findings: [
        finding({
          findingId: "f1",
          verification: { verdict: "inconclusive", evidence: "could not read the file" },
        }),
      ],
    });
    if (output.status !== "ok") throw new Error("expected ok");
    expect(output.findings[0]?.verification?.verdict).toBe("inconclusive");
  });

  it("round-trips an unverified finding unchanged (pre-#179 shape preserved)", () => {
    const output = parseCommandOutput("flagged.review", {
      status: "ok",
      findings: [finding({ findingId: "f1" })],
    });
    if (output.status !== "ok") throw new Error("expected ok");
    expect(output.findings[0]?.verification).toBeUndefined();
  });

  it("rejects a verification chip with a verdict outside the closed vocabulary (positive control)", () => {
    // Built raw (not via the typed helper) so the intentionally-invalid verdict is a
    // runtime value the schema must reject, not a compile error.
    expect(() =>
      parseCommandOutput("flagged.review", {
        status: "ok",
        findings: [
          {
            findingId: "f1",
            anchor: "rennet:hunk/h1",
            summary: "a concern",
            severity: "high",
            agreement: { kind: "concur", agree: 1, total: 1 },
            verification: { verdict: "maybe", evidence: "unsure" },
          },
        ],
      }),
    ).toThrow();
  });
});

describe("flagged.review — hypothesis delivery across the boundary (#178)", () => {
  it("carries the committed hypothesis through the output (it feeds the reading frame)", () => {
    const output = parseCommandOutput("flagged.review", {
      status: "ok",
      findings: [finding({ findingId: "f1" })],
      crossChecks: [{ riskId: "R1", status: "open", findingIds: [] }],
      hypothesis: HYPOTHESIS,
    });
    if (output.status !== "ok") throw new Error("expected ok");
    expect(output.hypothesis?.domain).toBe("per-org rate limiting");
    expect(output.hypothesis?.risks[0]?.riskId).toBe("R1");
    // The crossCheck references the SAME riskId — they travel together on purpose.
    expect(output.crossChecks?.[0]?.riskId).toBe("R1");
  });

  it("round-trips an ok review WITHOUT a hypothesis unchanged (pre-#178 shape preserved)", () => {
    const output = parseCommandOutput("flagged.review", {
      status: "ok",
      findings: [finding({ findingId: "f1" })],
    });
    if (output.status !== "ok") throw new Error("expected ok");
    expect(output.hypothesis).toBeUndefined();
  });

  it("rejects a hypothesis with a risk missing its riskId (positive control)", () => {
    expect(() =>
      parseCommandOutput("flagged.review", {
        status: "ok",
        findings: [finding({ findingId: "f1" })],
        hypothesis: {
          ...HYPOTHESIS,
          risks: [{ statement: "x", severity: "high", disconfirmer: "y" }],
        },
      }),
    ).toThrow();
  });
});
