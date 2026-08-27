import { describe, expect, it } from "vitest";
import { findingAdjudicationJsonSchema } from "./delta/bodies";
import { computeInputDigest, validateDocument } from "./delta/rsp";
import type { OfferedManifest, PatchsetRef } from "./index";

// The additive `agreement.adjudication` field on a disagree row (issue #41): a
// disagree row with NO adjudication validates exactly as before (the additive
// guarantee); a row WITH an adjudication chip admits; a bad verdict string rejects
// (the closed vocabulary is the V108 shape gate). Adjudication only ever rides the
// disagree arm — a concur row cannot carry it.

const PATCHSET: PatchsetRef = { id: "ps_1" };
const MANIFEST: OfferedManifest = {
  occurrences: [{ id: "h1", kind: "hunk", sides: { additions: ["const x = load();"] } }],
  lineage: [],
};
const DIGEST = computeInputDigest(PATCHSET, MANIFEST);
const LAYERS = { implementedByAdapter: true, advertisedByHarness: true, availableInSession: true };

function provenance() {
  return {
    harness: "claude-code",
    harnessVersion: "2.1.220",
    adapterVersion: "0.1.0",
    model: "claude-opus-4-8",
    modelReportedBy: "harness",
    tier: "heavy",
    route: "agentic",
    runId: "01J9X4RUN",
    inputDigest: DIGEST,
    capability: { structuredOutput: { ...LAYERS }, perCallModelSelection: { ...LAYERS } },
    tokens: { input: 2, output: 100, cacheRead: 0, cacheWrite: 5000, reasoning: null, total: 5102 },
    reportedUsd: null,
    derivedUsd: null,
  };
}

function findingDoc(agreement: Record<string, unknown>) {
  return {
    rsp: 1,
    docType: "finding",
    schemaVersion: 1,
    patchsetId: "ps_1",
    provenance: provenance(),
    body: {
      findings: [
        {
          findingId: "F1",
          anchor: "rennet:hunk/h1",
          summary: "load() can return null and the result is dereferenced unguarded",
          severity: "high",
          agreement,
        },
      ],
    },
    x: {},
  };
}

function disagree(adjudication?: Record<string, unknown>) {
  return {
    kind: "disagree",
    answers: [
      { model: "Claude", answer: "load() can return null" },
      { model: "Codex", answer: "no concern raised here" },
    ],
    ...(adjudication ? { adjudication } : {}),
  };
}

function validate(doc: unknown) {
  return validateDocument({ document: doc, patchset: PATCHSET, manifest: MANIFEST });
}

describe("agreement.adjudication additive field (#41)", () => {
  it("admits a disagree row with NO adjudication (unchanged from before)", () => {
    const report = validate(findingDoc(disagree()));
    expect(report.admitted).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it("admits a disagree row carrying a contradicted adjudication chip", () => {
    const report = validate(
      findingDoc(
        disagree({
          verdict: "contradicted",
          evidence: "the guard at line 12 already handles the null case",
          adjudicatedBy: "opus-4.8 (claude-code)",
        }),
      ),
    );
    expect(report.admitted).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it("admits an insufficient adjudication (surfaced, never dropped)", () => {
    const report = validate(
      findingDoc(
        disagree({
          verdict: "insufficient",
          evidence: "the review's adjudication cap of 4 was reached",
          adjudicatedBy: "gpt-5.6-sol (codex)",
        }),
      ),
    );
    expect(report.admitted).toBe(true);
  });

  it("rejects an adjudication with a verdict outside the closed vocabulary", () => {
    const report = validate(
      findingDoc(disagree({ verdict: "reproduced", evidence: "x", adjudicatedBy: "opus-4.8" })),
    );
    expect(report.admitted).toBe(false);
  });
});

describe("findingAdjudicationJsonSchema (#41)", () => {
  it("projects the adjudication-turn shape without the meta-schema ref", () => {
    const schema = findingAdjudicationJsonSchema() as Record<string, unknown>;
    expect(schema.$schema).toBeUndefined();
    expect(schema.type).toBe("object");
    const properties = schema.properties as Record<string, unknown>;
    expect(properties.adjudications).toBeDefined();
  });
});
