import type { OfferedManifest, PatchsetRef, RollupNarrationBody } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { computeInputDigest, validateDocument } from "./rsp";

// ── Fixtures: one manifest with a resolvable hunk, one valid narration ────────
//
// The narration node `anchor`s (rollup key, cohortKeys) are PLAIN keys, not
// `rennet:` code anchors, so the generic anchor walk ignores them — node coverage
// is the runner's floor, not the validator's. What the validator DOES enforce
// here: the body shape (V108), non-empty prose (V120/V121), and the byte-exact
// quote of any optional `{anchor, quote}` code citation (V006). `h1`'s additions
// give a real span so a correct citation resolves and a fabricated one rejects.

const PATCHSET: PatchsetRef = { id: "ps_1" };

const MANIFEST: OfferedManifest = {
  occurrences: [
    { id: "h1", kind: "hunk", sides: { additions: ["line one", "line two", "line three"] } },
    { id: "h2", kind: "hunk", sides: { additions: ["alpha", "beta"] } },
  ],
};

const DIGEST = computeInputDigest(PATCHSET, MANIFEST);
const LAYERS = { implementedByAdapter: true, advertisedByHarness: true, availableInSession: true };

function provenance(): Record<string, unknown> {
  return {
    harness: "codex",
    harnessVersion: "1.0.0",
    adapterVersion: "0.1.0",
    model: "gpt-5.6-luna",
    modelReportedBy: "config",
    tier: "light",
    route: "agentic",
    runId: "01J9X4RUN",
    inputDigest: DIGEST,
    capability: { structuredOutput: { ...LAYERS }, perCallModelSelection: { ...LAYERS } },
    tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: null, total: 15 },
    reportedUsd: null,
    derivedUsd: null,
  };
}

function narrationDoc(body: unknown): Record<string, unknown> {
  return {
    rsp: 1,
    docType: "rollup-narration",
    schemaVersion: 1,
    patchsetId: "ps_1",
    provenance: provenance(),
    body,
    x: {},
  };
}

const VALID: RollupNarrationBody = {
  narrations: [
    {
      altitude: "rollup",
      anchor: "rollup",
      oneLine: "A two-part change that adds the store and its callers.",
      paragraph: "The change lands a store and the code that uses it; read the store first.",
    },
    {
      altitude: "cohort",
      anchor: "cohort:c1",
      oneLine: "The store schema.",
      paragraph: "This cohort is the base everything else depends on.",
    },
  ],
};

function validate(doc: Record<string, unknown>) {
  return validateDocument({ document: doc, patchset: PATCHSET, manifest: MANIFEST });
}

function codes(report: ReturnType<typeof validate>): string[] {
  return report.errors.map((error) => error.code);
}

describe("rollup-narration body (issue #70)", () => {
  it("admits a well-formed narration batch", () => {
    expect(validate(narrationDoc(VALID)).admitted).toBe(true);
  });

  it("V108 — rejects an unknown altitude (shape gate)", () => {
    const report = validate(
      narrationDoc({
        narrations: [{ altitude: "galaxy", anchor: "rollup", oneLine: "x", paragraph: "y" }],
      }),
    );
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V108");
  });

  it("V120 — rejects an empty one-line account", () => {
    const report = validate(
      narrationDoc({
        narrations: [{ altitude: "rollup", anchor: "rollup", oneLine: "   ", paragraph: "real" }],
      }),
    );
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V120");
  });

  it("V121 — rejects an empty paragraph account", () => {
    const report = validate(
      narrationDoc({
        narrations: [{ altitude: "rollup", anchor: "rollup", oneLine: "real", paragraph: "" }],
      }),
    );
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V121");
  });

  it("admits an EXACT code citation (byte-verified against the resolved span)", () => {
    const report = validate(
      narrationDoc({
        narrations: [
          {
            altitude: "rollup",
            anchor: "rollup",
            oneLine: "adds two lines",
            paragraph: "the store gains two lines",
            evidence: [{ anchor: "rennet:hunk/h1#L1-L2@additions", quote: "line one\nline two" }],
          },
        ],
      }),
    );
    expect(report.admitted).toBe(true);
  });

  it("THE FABRICATED-QUOTE CONTROL — rejects a citation whose quote does not byte-match", () => {
    const report = validate(
      narrationDoc({
        narrations: [
          {
            altitude: "rollup",
            anchor: "rollup",
            oneLine: "adds two lines",
            paragraph: "the store gains two lines",
            // A fabricated quote: the real span is "line one\nline two".
            evidence: [{ anchor: "rennet:hunk/h1#L1-L2@additions", quote: "totally made up" }],
          },
        ],
      }),
    );
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V006");
  });

  it("rejects a citation anchoring a MINTED hunk id (agent invented a place)", () => {
    const report = validate(
      narrationDoc({
        narrations: [
          {
            altitude: "rollup",
            anchor: "rollup",
            oneLine: "cites nothing real",
            paragraph: "a citation to a hunk that was never offered",
            evidence: [{ anchor: "rennet:hunk/hNOPE", quote: "x" }],
          },
        ],
      }),
    );
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V008");
  });
});
