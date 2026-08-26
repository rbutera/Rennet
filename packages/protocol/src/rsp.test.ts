import { describe, expect, it } from "vitest";
import type { OfferedManifest, ParsedAnchor, PatchsetRef } from "./index";
import {
  canonicalize,
  computeInputDigest,
  parseAnchor,
  resolveAnchor,
  validateDocument,
} from "./rsp";

// ── Fixtures: one manifest, one valid document, mutated per rule ──────────────

const PATCHSET: PatchsetRef = { id: "ps_1" };

const MANIFEST: OfferedManifest = {
  occurrences: [
    { id: "h1", kind: "hunk", sides: { additions: ["line one", "line two", "line three"] } },
    { id: "h2", kind: "hunk", sides: { additions: ["alpha", "beta"] } },
    { id: "f_CTRL01", kind: "file" },
  ],
  lineage: [
    { fromId: "hOld", lineage: "one-to-one", toId: "h1" },
    { fromId: "hDead", lineage: "terminated" },
    { fromId: "hAmbig", lineage: "ambiguous", toId: "h1" },
  ],
};

const DIGEST = computeInputDigest(PATCHSET, MANIFEST);

const LAYERS = { implementedByAdapter: true, advertisedByHarness: true, availableInSession: true };

function provenance(inputDigest = DIGEST): Record<string, unknown> {
  return {
    harness: "claude-code",
    harnessVersion: "2.1.220",
    adapterVersion: "0.1.0",
    model: "claude-opus-4-6",
    modelReportedBy: "harness",
    tier: "heavy",
    route: "agentic",
    runId: "01J9X4RUN",
    inputDigest,
    capability: { structuredOutput: { ...LAYERS }, perCallModelSelection: { ...LAYERS } },
    tokens: {
      input: 41022,
      output: 3180,
      cacheRead: 38900,
      cacheWrite: 0,
      reasoning: null,
      total: 44202,
    },
    reportedUsd: null,
    derivedUsd: null,
  };
}

/** A valid ATOMIC document with one resolvable anchor+quote in its opaque body.
 *  Uses `adjudication` — an atomic docType with no per-body schema in this slice —
 *  so these tests exercise ONLY the generic envelope/anchor/quote machinery.
 *  The decomposition body schemas are tested against real bodies in bodies.test.ts.
 *  Admits by default. */
function baseDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rsp: 1,
    docType: "adjudication",
    schemaVersion: 1,
    patchsetId: "ps_1",
    provenance: provenance(),
    body: { evidence: [{ anchor: "rennet:hunk/h1#L1-L2@additions", quote: "line one\nline two" }] },
    x: {},
    ...overrides,
  };
}

function validate(
  document: unknown,
  settings?: Parameters<typeof validateDocument>[0]["settings"],
) {
  return validateDocument({ document, patchset: PATCHSET, manifest: MANIFEST, settings });
}

function codes(report: ReturnType<typeof validate>): string[] {
  return report.errors.map((error) => error.code);
}

// ── The happy path (and the standalone / zero-app-context property) ───────────

describe("validateDocument — admission", () => {
  it("admits a well-formed document against only a fixture manifest (zero app context)", () => {
    const report = validate(baseDoc());
    expect(report.admitted).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.rejectedItemCount).toBe(0);
  });
});

// ── One fixture per validator rule, in BOTH directions ───────────────────────

describe("V001 — rsp major, known docType, schemaVersion window", () => {
  it("admits rsp major 1", () => {
    expect(validate(baseDoc()).admitted).toBe(true);
  });
  it("rejects an unsupported rsp major", () => {
    const report = validate(baseDoc({ rsp: 2 }));
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V001");
  });
  it("rejects an unknown docType loudly", () => {
    const report = validate(baseDoc({ docType: "banana" }));
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V001");
    expect(report.errors[0]?.message).toContain("banana");
  });
  it("rejects a schemaVersion outside the supported window", () => {
    const report = validate(baseDoc({ schemaVersion: 99 }));
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V001");
  });
});

describe("V002 — envelope + provenance schema", () => {
  it("admits a complete envelope", () => {
    expect(validate(baseDoc()).admitted).toBe(true);
  });
  it("rejects a provenance missing a required field", () => {
    const broken = provenance();
    delete broken.tokens;
    const report = validate(baseDoc({ provenance: broken }));
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V002");
  });
  it("rejects a document with no extension bag", () => {
    const doc = baseDoc();
    delete doc.x;
    const report = validate(doc);
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V002");
  });
});

describe("V003 — provenance capability completeness", () => {
  it("admits both required capabilities with three layers each", () => {
    expect(validate(baseDoc()).admitted).toBe(true);
  });
  it("rejects a provenance missing a required capability name", () => {
    const broken = provenance();
    broken.capability = { structuredOutput: { ...LAYERS } };
    const report = validate(baseDoc({ provenance: broken }));
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V003");
  });
});

describe("V004 — size limits reject, never truncate", () => {
  it("admits under the document byte limit", () => {
    expect(validate(baseDoc()).admitted).toBe(true);
  });
  it("rejects a document over the byte limit", () => {
    const report = validate(baseDoc(), { sizeLimits: { documentBytes: 64, quoteBytes: 2048 } });
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V004");
  });
  it("rejects an over-long quote", () => {
    const doc = baseDoc({
      body: { evidence: [{ anchor: "rennet:hunk/h1#L1-L2@additions", quote: "x".repeat(50) }] },
    });
    const report = validate(doc, { sizeLimits: { documentBytes: 512 * 1024, quoteBytes: 8 } });
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V004");
  });
});

describe("V005 — anchor resolution", () => {
  it("admits an in-bounds span", () => {
    expect(validate(baseDoc()).admitted).toBe(true);
  });
  it("rejects a span out of bounds", () => {
    const doc = baseDoc({
      body: {
        evidence: [{ anchor: "rennet:hunk/h1#L1-L9@additions", quote: "line one\nline two" }],
      },
    });
    const report = validate(doc);
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V005");
  });
  it("rejects a malformed anchor string", () => {
    const report = validate(baseDoc({ body: { refs: ["rennet:hunk/"] } }));
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V005");
  });
});

describe("V006 — quote byte-match", () => {
  it("admits an exact quote", () => {
    expect(validate(baseDoc()).admitted).toBe(true);
  });
  it("rejects a paraphrased quote on byte-match", () => {
    const doc = baseDoc({
      body: { evidence: [{ anchor: "rennet:hunk/h1#L1-L2@additions", quote: "line 1\nline 2" }] },
    });
    const report = validate(doc);
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V006");
  });
  it("admits a quote differing only in trailing whitespace (declared normalisation)", () => {
    const doc = baseDoc({
      body: {
        evidence: [{ anchor: "rennet:hunk/h1#L1-L2@additions", quote: "line one  \nline two\t" }],
      },
    });
    expect(validate(doc).admitted).toBe(true);
  });
});

describe("V007 — closed anchor vocabulary", () => {
  it("admits a valid anchor kind", () => {
    expect(validate(baseDoc()).admitted).toBe(true);
  });
  it("rejects an anchor kind outside the closed vocabulary", () => {
    const report = validate(baseDoc({ body: { refs: ["rennet:banana/h1"] } }));
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V007");
  });
  it("rejects an anchor side outside the closed vocabulary", () => {
    const report = validate(baseDoc({ body: { refs: ["rennet:hunk/h1#L1@sideways"] } }));
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V007");
  });
});

describe("V008 — no agent-minted identity", () => {
  it("admits an id present in the offered manifest", () => {
    expect(validate(baseDoc()).admitted).toBe(true);
  });
  it("rejects a fabricated anchor id (parse-time rejection)", () => {
    const report = validate(baseDoc({ body: { refs: ["rennet:hunk/hNOPE"] } }));
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V008");
  });
});

describe("V009 — inputDigest equals the offered manifest", () => {
  it("admits the correct digest", () => {
    expect(validate(baseDoc()).admitted).toBe(true);
  });
  it("rejects a mismatched inputDigest", () => {
    const report = validate(baseDoc({ provenance: provenance("sha256:deadbeef") }));
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V009");
  });
});

// ── Round-trip: unknown keys survive; unknown docType rejects ────────────────

describe("round-trip preservation", () => {
  it("preserves unknown x keys through canonical serialisation", () => {
    const doc = baseDoc({ x: { customVendorKey: { deep: [1, 2, 3] }, another: "kept" } });
    const roundTripped = JSON.parse(canonicalize(doc)) as { x: Record<string, unknown> };
    expect(roundTripped.x).toEqual({ customVendorKey: { deep: [1, 2, 3] }, another: "kept" });
  });
  it("preserves unknown top-level keys (no silent loss)", () => {
    const doc = baseDoc({ vendorExtension: "kept" });
    const report = validateDocument({ document: doc, patchset: PATCHSET, manifest: MANIFEST });
    expect(report.admitted).toBe(true);
  });
});

// ── Admission granularity: atomic vs item-wise ───────────────────────────────

describe("admission granularity", () => {
  it("rejects an atomic document wholesale on a single bad anchor", () => {
    const doc = baseDoc({ body: { evidence: [{ anchor: "rennet:hunk/hNOPE", quote: "x" }] } });
    const report = validate(doc);
    expect(report.admission).toBe("atomic");
    expect(report.admitted).toBe(false);
    expect(report.rejectedItems).toEqual([]);
  });

  it("admits an item-wise document item-by-item with a visible rejected count", () => {
    const doc = baseDoc({
      docType: "decision.record",
      body: {
        decisions: [
          {
            decisionId: "d1",
            evidence: [{ anchor: "rennet:hunk/h1#L1-L2@additions", quote: "line one\nline two" }],
          },
          {
            decisionId: "d2",
            evidence: [{ anchor: "rennet:hunk/h2#L1@additions", quote: "alpha" }],
          },
          { decisionId: "d3", evidence: [{ anchor: "rennet:hunk/hNOPE", quote: "x" }] },
        ],
      },
    });
    const report = validate(doc);
    expect(report.admission).toBe("itemwise");
    expect(report.admitted).toBe(true);
    expect(report.admittedItemCount).toBe(2);
    expect(report.rejectedItemCount).toBe(1);
    expect(report.rejectedItems[0]?.pointer).toBe("/body/decisions/2");
    expect(report.rejectedItems[0]?.errors.map((error) => error.code)).toContain("V008");
  });

  it("admits a clean item-wise document with a zero rejected count", () => {
    const doc = baseDoc({
      docType: "decision.record",
      body: {
        decisions: [
          {
            decisionId: "d1",
            evidence: [{ anchor: "rennet:hunk/h1#L1@additions", quote: "line one" }],
          },
        ],
      },
    });
    const report = validate(doc);
    expect(report.admitted).toBe(true);
    expect(report.rejectedItemCount).toBe(0);
    expect(report.admittedItemCount).toBe(1);
  });

  // Decisions are NEVER capped or truncated (frozen doctrine #1: a cap can hide
  // the one decision the user must answer for). Absence of `maxItems` in the
  // schema is not enough — a future `maxItems`, `.slice()`, or a paginating
  // change would pass every other test green. These two feed a LARGE collection
  // and assert every item is processed, so the guarantee can actually go red.
  it("never caps a large decision collection — all 500 valid items are admitted", () => {
    const decisions = Array.from({ length: 500 }, (_, index) => ({
      decisionId: `d${index}`,
      evidence: [{ anchor: "rennet:hunk/h1#L1@additions", quote: "line one" }],
    }));
    const report = validate(baseDoc({ docType: "decision.record", body: { decisions } }));
    expect(report.admission).toBe("itemwise");
    expect(report.admitted).toBe(true);
    expect(report.admittedItemCount).toBe(500);
    expect(report.rejectedItemCount).toBe(0);
  });

  it("never caps the rejected count — all 500 invalid items are reported", () => {
    const decisions = Array.from({ length: 500 }, (_, index) => ({
      decisionId: `d${index}`,
      evidence: [{ anchor: "rennet:hunk/hNOPE", quote: "x" }],
    }));
    const report = validate(baseDoc({ docType: "decision.record", body: { decisions } }));
    expect(report.rejectedItemCount).toBe(500);
    expect(report.rejectedItems.length).toBe(500);
  });
});

// ── The resolution function: four outcomes, ambiguity fails closed ───────────

function anchor(raw: string): ParsedAnchor {
  const parsed = parseAnchor(raw);
  if (!parsed.ok) throw new Error(`fixture anchor did not parse: ${raw}`);
  return parsed.anchor;
}

describe("resolveAnchor — the total function with four outcomes", () => {
  it("resolves an id present in the manifest", () => {
    const resolution = resolveAnchor(anchor("rennet:hunk/h1#L1-L2@additions"), MANIFEST);
    expect(resolution.outcome).toBe("resolved");
    expect(resolution.resolvedText).toBe("line one\nline two");
  });
  it("returns unresolved for a minted id", () => {
    expect(resolveAnchor(anchor("rennet:hunk/hNOPE"), MANIFEST).outcome).toBe("unresolved");
  });
  it("supersedes a CHANGED (one-to-one) id to its successor but does NOT carry state", () => {
    // Issue #16 Critical: `hOld` is a `one-to-one` (edited) lineage. It maps
    // forward (superseded → re-anchor to h1) but read/analysis state must NOT
    // carry — a changed occurrence reopens. This test previously pinned
    // carriesState:true, i.e. state carried onto edited code.
    const resolution = resolveAnchor(anchor("rennet:hunk/hOld"), MANIFEST);
    expect(resolution.outcome).toBe("superseded");
    expect(resolution.occurrenceId).toBe("h1");
    expect(resolution.carriesState).toBe(false);
  });
  it("returns orphaned for a terminated lineage", () => {
    const resolution = resolveAnchor(anchor("rennet:hunk/hDead"), MANIFEST);
    expect(resolution.outcome).toBe("orphaned");
    expect(resolution.carriesState).toBe(false);
  });
  it("fails closed on ambiguous lineage: orphaned, never carrying state", () => {
    const resolution = resolveAnchor(anchor("rennet:hunk/hAmbig"), MANIFEST);
    expect(resolution.outcome).toBe("orphaned");
    expect(resolution.carriesState).toBe(false);
  });
});

// ── The carry authority across ALL seven lineage classes (issue #16 Critical 2) ─
// `carriesState` is the BINDING gate the disposition seam shares via the single
// `autoCarries` authority in `@rennet/types`. Only `exact` may carry; every other
// mapped class supersedes (re-anchors) or orphans WITHOUT carrying state. Before
// the fix, resolveAnchor returned carriesState:true for every targeted non-ambiguous
// class — one-to-one/move/split/merge all carried read state onto changed code.
describe("resolveAnchor — carry authority is exact-only across all seven classes", () => {
  const SEVEN: OfferedManifest = {
    occurrences: [{ id: "hNew", kind: "hunk", sides: { additions: ["x"] } }],
    lineage: [
      { fromId: "hExact", lineage: "exact", toId: "hNew" },
      { fromId: "hOneToOne", lineage: "one-to-one", toId: "hNew" },
      { fromId: "hMove", lineage: "move", toId: "hNew" },
      { fromId: "hSplit", lineage: "split", toId: "hNew" },
      { fromId: "hMerge", lineage: "merge", toId: "hNew" },
      { fromId: "hAmbiguous", lineage: "ambiguous", toId: "hNew" },
      { fromId: "hTerminated", lineage: "terminated" },
    ],
  };

  it("carries state ONLY for exact", () => {
    expect(resolveAnchor(anchor("rennet:hunk/hExact"), SEVEN).carriesState).toBe(true);
  });

  it.each(["hOneToOne", "hMove", "hSplit", "hMerge"])(
    "supersedes %s to its successor but never carries state",
    (fromId) => {
      const resolution = resolveAnchor(anchor(`rennet:hunk/${fromId}`), SEVEN);
      expect(resolution.outcome).toBe("superseded");
      expect(resolution.occurrenceId).toBe("hNew");
      expect(resolution.carriesState).toBe(false);
    },
  );

  it.each(["hAmbiguous", "hTerminated"])("orphans %s, never carrying state", (fromId) => {
    const resolution = resolveAnchor(anchor(`rennet:hunk/${fromId}`), SEVEN);
    expect(resolution.outcome).toBe("orphaned");
    expect(resolution.carriesState).toBe(false);
  });
});

// ── Anchor grammar parse ─────────────────────────────────────────────────────

describe("parseAnchor", () => {
  it("parses a side-qualified span", () => {
    const parsed = parseAnchor("rennet:hunk/h_2MMD02#L14-L31@additions");
    expect(parsed).toEqual({
      ok: true,
      anchor: {
        raw: "rennet:hunk/h_2MMD02#L14-L31@additions",
        kind: "hunk",
        id: "h_2MMD02",
        span: { startLine: 14, endLine: 31 },
        side: "additions",
      },
    });
  });
  it("parses a symbol path id containing slashes and dots", () => {
    const parsed = parseAnchor("rennet:symbol/f_CTRL01/FlightsController.ByAirport");
    expect(parsed.ok).toBe(true);
  });
  it("parses a chunk anchor carrying its proposal", () => {
    const parsed = parseAnchor("rennet:chunk/c2^01J9X4Q2K7ZC3M0R8T5V6WYA1B");
    expect(parsed.ok && parsed.anchor.proposal).toBe("01J9X4Q2K7ZC3M0R8T5V6WYA1B");
  });
  it("rejects an unknown kind", () => {
    expect(parseAnchor("rennet:banana/x")).toEqual({ ok: false, reason: "unknown-kind" });
  });
  it("rejects a reversed span", () => {
    expect(parseAnchor("rennet:hunk/h1#L9-L2@additions")).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});

// ── Canonical serialisation + input digest ───────────────────────────────────

describe("canonicalize", () => {
  it("sorts keys deeply and indents with two spaces and LF", () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{\n  "a": {\n    "c": 3,\n    "d": 2\n  },\n  "b": 1\n}',
    );
  });
  it("preserves array order", () => {
    expect(canonicalize([3, 1, 2])).toBe("[\n  3,\n  1,\n  2\n]");
  });
});

describe("computeInputDigest", () => {
  it("is order-independent over occurrences", () => {
    const reordered: OfferedManifest = {
      occurrences: [...MANIFEST.occurrences].reverse(),
      lineage: MANIFEST.lineage,
    };
    expect(computeInputDigest(PATCHSET, reordered)).toBe(DIGEST);
  });
  it("changes when an occurrence's content changes", () => {
    const changed: OfferedManifest = {
      occurrences: [{ id: "h1", kind: "hunk", sides: { additions: ["different"] } }],
    };
    expect(computeInputDigest(PATCHSET, changed)).not.toBe(DIGEST);
  });
  it("is prefixed sha256", () => {
    expect(DIGEST).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
