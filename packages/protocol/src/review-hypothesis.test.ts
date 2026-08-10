import type { OfferedManifest, PatchsetRef } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { computeInputDigest, validateDocument } from "./rsp";

// The `review.hypothesis` validator (issue #178): an ATOMIC doc — any body error
// rejects the whole document. Its rules: a non-empty domain (V150), a non-empty
// design expectation (V152), a risk count within 5-10 (V153), and each risk's
// non-empty statement (V154) + disconfirmer (V155). The severity enum + scope
// shape are the V108 shape gate.

const PATCHSET: PatchsetRef = { id: "ps_1" };
const MANIFEST: OfferedManifest = {
  occurrences: [{ id: "h1", kind: "hunk", sides: { additions: ["line one"] } }],
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

function risk(overrides: Record<string, unknown> = {}) {
  return {
    riskId: "R1",
    statement: "the store key is computed per branch instead of per repository root",
    severity: "high",
    disconfirmer: "check the key uses git-common-dir, not the branch name",
    ...overrides,
  };
}

function hypothesisDoc(bodyOverrides: Record<string, unknown> = {}) {
  const risks = Array.from({ length: 7 }, (_, i) => risk({ riskId: `R${i}` }));
  return {
    rsp: 1,
    docType: "review.hypothesis",
    schemaVersion: 1,
    patchsetId: "ps_1",
    provenance: provenance(),
    body: {
      domain: "key the review store per repository so worktrees share one entry",
      scope: { inScope: ["store keying"], outOfScope: ["the knowledge layer"] },
      designExpectation: "resolve the key from realpath(git-common-dir), never the branch",
      risks,
      ...bodyOverrides,
    },
    x: {},
  };
}

function validate(doc: unknown) {
  return validateDocument({ document: doc, patchset: PATCHSET, manifest: MANIFEST });
}

describe("review.hypothesis validator (#178)", () => {
  it("admits a well-formed hypothesis with seven valid risks", () => {
    const report = validate(hypothesisDoc());
    expect(report.admitted).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it("rejects atomically when the risk count is below the 5-10 bound (V153)", () => {
    const report = validate(hypothesisDoc({ risks: [risk(), risk(), risk()] }));
    expect(report.admitted).toBe(false);
    expect(report.errors.some((e) => e.code === "V153")).toBe(true);
  });

  it("rejects atomically when the risk count is above the bound (V153)", () => {
    const report = validate(
      hypothesisDoc({ risks: Array.from({ length: 11 }, (_, i) => risk({ riskId: `R${i}` })) }),
    );
    expect(report.admitted).toBe(false);
    expect(report.errors.some((e) => e.code === "V153")).toBe(true);
  });

  it("rejects a risk with an out-of-vocabulary severity (V108 shape gate)", () => {
    const risks = [risk({ severity: "critical" }), ...Array.from({ length: 5 }, () => risk())];
    const report = validate(hypothesisDoc({ risks }));
    expect(report.admitted).toBe(false);
  });

  it("rejects an empty domain (V150)", () => {
    const report = validate(hypothesisDoc({ domain: "   " }));
    expect(report.admitted).toBe(false);
    expect(report.errors.some((e) => e.code === "V150")).toBe(true);
  });

  it("rejects a word-less disconfirmer (V155)", () => {
    const risks = [risk({ disconfirmer: "" }), ...Array.from({ length: 5 }, () => risk())];
    const report = validate(hypothesisDoc({ risks }));
    expect(report.admitted).toBe(false);
    expect(report.errors.some((e) => e.code === "V155")).toBe(true);
  });
});
