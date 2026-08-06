import type { OfferedManifest, OrderingBody, PatchsetRef } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { bodyJsonSchema } from "./bodies";
import { computeInputDigest, validateDocument } from "./rsp";

// ── Fixtures: three offered CHUNKS (not hunks), one valid ordering, mutated ────

const PATCHSET: PatchsetRef = { id: "ps_1" };

const CHUNK_MANIFEST: OfferedManifest = {
  occurrences: [
    { id: "c1", kind: "chunk" },
    { id: "c2", kind: "chunk" },
    { id: "c3", kind: "chunk" },
  ],
};

const DIGEST = computeInputDigest(PATCHSET, CHUNK_MANIFEST);
const LAYERS = { implementedByAdapter: true, advertisedByHarness: true, availableInSession: true };

function provenance(): Record<string, unknown> {
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
    tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: null, total: 15 },
    reportedUsd: null,
    derivedUsd: null,
  };
}

function orderingDoc(body: unknown): Record<string, unknown> {
  return {
    rsp: 1,
    docType: "ordering",
    schemaVersion: 1,
    patchsetId: "ps_1",
    provenance: provenance(),
    body,
    x: {},
  };
}

const VALID_ORDERING: OrderingBody = {
  readingOrder: ["c1", "c2", "c3"],
  rationale: "High-level shape first, then ground-up detail.",
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validate(document: unknown) {
  return validateDocument({ document, patchset: PATCHSET, manifest: CHUNK_MANIFEST });
}

function codes(report: ReturnType<typeof validate>): string[] {
  return report.errors.map((error) => error.code);
}

describe("ordering document — admission", () => {
  it("admits a well-formed ordering over the offered chunk set", () => {
    const report = validate(orderingDoc(VALID_ORDERING));
    expect(report.admitted).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it("admits a reordering of the offered chunks (agent order need not equal baseline)", () => {
    const body = clone(VALID_ORDERING);
    body.readingOrder = ["c3", "c1", "c2"];
    expect(validate(orderingDoc(body)).admitted).toBe(true);
  });
});

describe("V111 — the order covers every offered chunk exactly once (totality)", () => {
  it("rejects an offered chunk missing from the order", () => {
    const body = clone(VALID_ORDERING);
    body.readingOrder = ["c1", "c2"]; // c3 omitted
    const report = validate(orderingDoc(body));
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V111");
  });

  it("rejects a chunk ordered more than once", () => {
    const body = clone(VALID_ORDERING);
    body.readingOrder = ["c1", "c2", "c3", "c1"]; // c1 twice
    const report = validate(orderingDoc(body));
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V111");
  });
});

describe("V112 — the order references no minted chunk identity", () => {
  it("rejects a fabricated chunk id not in the offered set", () => {
    const body = clone(VALID_ORDERING);
    body.readingOrder = ["c1", "c2", "c3", "c9"]; // c9 was never offered
    const report = validate(orderingDoc(body));
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V112");
  });
});

describe("V113 — the ordering carries a non-empty rationale", () => {
  it("rejects a whitespace-only rationale", () => {
    const body = clone(VALID_ORDERING);
    body.rationale = "   ";
    const report = validate(orderingDoc(body));
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V113");
  });
});

describe("V108 — the ordering body has the wrong shape", () => {
  it("rejects a body missing readingOrder", () => {
    const report = validate(orderingDoc({ rationale: "no order here" }));
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V108");
  });

  it("rejects a body whose rationale is not a string", () => {
    const report = validate(orderingDoc({ readingOrder: ["c1", "c2", "c3"], rationale: 7 }));
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V108");
  });
});

describe("bodyJsonSchema for ordering", () => {
  it("projects an object JSON schema for the structured-output constraint", () => {
    const schema = bodyJsonSchema("ordering") as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect(schema).toHaveProperty("properties");
  });
});
