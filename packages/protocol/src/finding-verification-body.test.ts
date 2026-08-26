import { describe, expect, it } from "vitest";
import { findingVerificationJsonSchema } from "./bodies";
import type { OfferedManifest, PatchsetRef } from "./index";
import { computeInputDigest, validateDocument } from "./rsp";

// The additive `finding.verification` field (issue #179): a finding with no
// verification validates exactly as before (the additive-superset guarantee); a
// finding WITH a verification chip admits; an empty-evidence chip rejects (V132).
// The verdict enum is the V108 shape gate.

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

function findingDoc(findingOverrides: Record<string, unknown> = {}) {
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
          agreement: { kind: "concur", agree: 1, total: 1 },
          ...findingOverrides,
        },
      ],
    },
    x: {},
  };
}

function validate(doc: unknown) {
  return validateDocument({ document: doc, patchset: PATCHSET, manifest: MANIFEST });
}

describe("finding.verification additive field (#179)", () => {
  it("admits a finding with NO verification (unchanged from before)", () => {
    const report = validate(findingDoc());
    expect(report.admitted).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it("admits a finding carrying a reproduced verification chip", () => {
    const report = validate(
      findingDoc({
        verification: {
          verdict: "reproduced",
          evidence:
            "load() returns T | null at line 12 and line 14 dereferences it without a guard",
        },
      }),
    );
    expect(report.admitted).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it("admits an inconclusive chip (surfaced with a caveat, never dropped)", () => {
    const report = validate(
      findingDoc({ verification: { verdict: "inconclusive", evidence: "could not verify" } }),
    );
    expect(report.admitted).toBe(true);
  });

  it("rejects a verification chip with empty evidence (V132)", () => {
    const report = validate(
      findingDoc({ verification: { verdict: "reproduced", evidence: "   " } }),
    );
    expect(report.admitted).toBe(false);
    expect(report.errors.some((error) => error.code === "V132")).toBe(true);
  });

  it("rejects a verification chip with a verdict outside the closed vocabulary (V108 shape)", () => {
    const report = validate(findingDoc({ verification: { verdict: "maybe", evidence: "unsure" } }));
    expect(report.admitted).toBe(false);
  });
});

describe("findingVerificationJsonSchema (#179)", () => {
  it("projects the batched verify-turn shape without the meta-schema ref", () => {
    const schema = findingVerificationJsonSchema() as Record<string, unknown>;
    expect(schema.$schema).toBeUndefined();
    expect(schema.type).toBe("object");
    const properties = schema.properties as Record<string, unknown>;
    expect(properties.verifications).toBeDefined();
  });
});
