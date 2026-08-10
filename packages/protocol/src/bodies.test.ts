import type {
  DecompositionProposalBody,
  DecompositionSkeletonBody,
  OfferedManifest,
  PatchsetRef,
  ProposalChunk,
} from "@rennet/types";
import { describe, expect, it } from "vitest";
import { bodyJsonSchema, CHUNK_ASSIGNABLE_ANGLES } from "./bodies";
import { computeInputDigest, validateDocument } from "./rsp";

/** Fixture accessor: a chunk that must exist, without a non-null assertion. */
function chunkAt(body: DecompositionProposalBody, index: number): ProposalChunk {
  const chunk = body.chunks[index];
  if (!chunk) throw new Error(`fixture is missing chunk ${index}`);
  return chunk;
}

// ── Fixtures: three offered hunks, one valid proposal + skeleton, mutated ─────

const PATCHSET: PatchsetRef = { id: "ps_1" };

const MANIFEST: OfferedManifest = {
  occurrences: [
    { id: "h1", kind: "hunk", sides: { additions: ["a"] } },
    { id: "h2", kind: "hunk", sides: { additions: ["b"] } },
    { id: "h3", kind: "hunk", sides: { additions: ["c"] } },
  ],
};

const DIGEST = computeInputDigest(PATCHSET, MANIFEST);
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

function proposalDoc(body: unknown): Record<string, unknown> {
  return {
    rsp: 1,
    docType: "decomposition.proposal",
    schemaVersion: 1,
    patchsetId: "ps_1",
    provenance: provenance(),
    body,
    x: {},
  };
}

function skeletonDoc(body: unknown): Record<string, unknown> {
  return {
    rsp: 1,
    docType: "decomposition.skeleton",
    schemaVersion: 1,
    patchsetId: "ps_1",
    provenance: provenance(),
    body,
    x: {},
  };
}

const VALID_PROPOSAL: DecompositionProposalBody = {
  chunks: [
    { chunkId: "c1", title: "core", hunkIds: ["h1"], angles: ["sequence"], rationale: "the base" },
    {
      chunkId: "c2",
      title: "callers",
      hunkIds: ["h2", "h3"],
      angles: ["decisions"],
      rationale: "the users of the base",
    },
  ],
  edges: [{ from: "c1", to: "c2", kind: "enables" }],
  readingOrder: ["c1", "c2"],
  residue: [],
};

const VALID_SKELETON: DecompositionSkeletonBody = {
  chunks: [
    { chunkId: "c1", hunkIds: ["h1"], angles: ["sequence"] },
    { chunkId: "c2", hunkIds: ["h2", "h3"], angles: ["claims"] },
  ],
  readingOrder: ["c1", "c2"],
  residue: [],
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validate(document: unknown) {
  return validateDocument({ document, patchset: PATCHSET, manifest: MANIFEST });
}

function codes(report: ReturnType<typeof validate>): string[] {
  return report.errors.map((error) => error.code);
}

describe("decomposition bodies — admission", () => {
  it("admits a well-formed proposal", () => {
    const report = validate(proposalDoc(VALID_PROPOSAL));
    expect(report.admitted).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it("admits a well-formed skeleton", () => {
    const report = validate(skeletonDoc(VALID_SKELETON));
    expect(report.admitted).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it("admits a proposal that places a hunk in residue", () => {
    const body = clone(VALID_PROPOSAL);
    chunkAt(body, 1).hunkIds = ["h2"];
    body.residue = [{ hunkId: "h3", reason: "not placeable in a chunk" }];
    expect(validate(proposalDoc(body)).admitted).toBe(true);
  });
});

describe("V100 — totality is an exact partition of the offered hunks", () => {
  it("rejects a missing hunk", () => {
    const body = clone(VALID_PROPOSAL);
    chunkAt(body, 1).hunkIds = ["h2"]; // h3 now placed nowhere
    const report = validate(proposalDoc(body));
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V100");
  });

  it("rejects a minted hunk not in the offered manifest", () => {
    const body = clone(VALID_PROPOSAL);
    chunkAt(body, 1).hunkIds = ["h2", "h3", "h9"];
    const report = validate(proposalDoc(body));
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V100");
  });
});

describe("V101 — no duplication across chunks", () => {
  it("rejects the same hunk placed in two chunks", () => {
    const body = clone(VALID_PROPOSAL);
    chunkAt(body, 0).hunkIds = ["h1", "h2"];
    chunkAt(body, 1).hunkIds = ["h2", "h3"]; // h2 in both c1 and c2
    const report = validate(proposalDoc(body));
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V101");
  });
});

describe("V103 — acyclic edges + topological reading-order cover", () => {
  it("rejects a cycle in the edges", () => {
    const body = clone(VALID_PROPOSAL);
    body.edges = [
      { from: "c1", to: "c2", kind: "enables" },
      { from: "c2", to: "c1", kind: "enables" },
    ];
    const report = validate(proposalDoc(body));
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V103");
  });

  it("rejects a reading order that misses a chunk", () => {
    const body = clone(VALID_PROPOSAL);
    body.readingOrder = ["c1"]; // c2 not covered
    const report = validate(proposalDoc(body));
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V103");
  });

  it("rejects a reading order that violates an edge", () => {
    const body = clone(VALID_PROPOSAL);
    body.readingOrder = ["c2", "c1"]; // edge c1->c2 requires c1 first
    const report = validate(proposalDoc(body));
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V103");
  });

  it("checks the skeleton reading order covers every chunk", () => {
    const body = clone(VALID_SKELETON);
    body.readingOrder = ["c1"]; // c2 not covered
    const report = validate(skeletonDoc(body));
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V103");
  });
});

describe("V104 — only chunk-assignable angles", () => {
  it("exposes the closed set", () => {
    expect([...CHUNK_ASSIGNABLE_ANGLES]).toEqual([
      "sequence",
      "decisions",
      "claims",
      "blast-radius",
    ]);
  });

  it("rejects a chunk assigned to noise", () => {
    const body = clone(VALID_PROPOSAL);
    (chunkAt(body, 0) as { angles: string[] }).angles = ["noise"];
    const report = validate(proposalDoc(body));
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V104");
  });

  it("rejects a chunk assigned to spec", () => {
    const body = clone(VALID_PROPOSAL);
    (chunkAt(body, 1) as { angles: string[] }).angles = ["spec"];
    const report = validate(proposalDoc(body));
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V104");
  });
});

describe("V105 — proposal chunks carry a non-empty rationale", () => {
  it("rejects an empty rationale", () => {
    const body = clone(VALID_PROPOSAL);
    chunkAt(body, 0).rationale = "   ";
    const report = validate(proposalDoc(body));
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V105");
  });
});

describe("V106 — the chunk graph is referentially complete", () => {
  it("rejects a dangling edge endpoint", () => {
    const body = clone(VALID_PROPOSAL);
    body.edges = [{ from: "c1", to: "c9", kind: "enables" }];
    const report = validate(proposalDoc(body));
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V106");
  });

  it("rejects a duplicate chunk id", () => {
    const body = clone(VALID_PROPOSAL);
    chunkAt(body, 1).chunkId = "c1"; // two chunks named c1
    body.readingOrder = ["c1", "c1"];
    const report = validate(proposalDoc(body));
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V106");
  });
});

describe("V108 — the body has the wrong shape", () => {
  it("rejects a body missing readingOrder", () => {
    const report = validate(proposalDoc({ chunks: [], edges: [], residue: [] }));
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V108");
  });

  it("rejects a body whose chunks is not an array", () => {
    const report = validate(
      proposalDoc({ chunks: "nope", edges: [], readingOrder: [], residue: [] }),
    );
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V108");
  });
});

describe("bodyJsonSchema", () => {
  it("projects an object JSON schema for each decomposition docType", () => {
    for (const docType of ["decomposition.skeleton", "decomposition.proposal"] as const) {
      const schema = bodyJsonSchema(docType) as Record<string, unknown>;
      expect(schema.type).toBe("object");
      expect(schema).toHaveProperty("properties");
    }
  });

  it("returns null for a docType with no body schema in this slice", () => {
    expect(bodyJsonSchema("adjudication")).toBeNull();
  });
});

// ── The finding body (issue #32 / #138) ──────────────────────────────────────

function findingDoc(body: unknown): Record<string, unknown> {
  return {
    rsp: 1,
    docType: "finding",
    schemaVersion: 1,
    patchsetId: "ps_1",
    provenance: provenance(),
    body,
    x: {},
  };
}

/** One well-formed finding anchored to an offered hunk (h1..h3 in MANIFEST). */
function finding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    findingId: "f1",
    anchor: "rennet:hunk/h1",
    summary: "the added branch never releases the lock on the early-return path",
    severity: "high",
    agreement: { kind: "concur", agree: 1, total: 1 },
    ...overrides,
  };
}

describe("finding body — admission (issue #32)", () => {
  it("admits a well-formed finding anchored to an offered hunk", () => {
    const report = validate(findingDoc({ findings: [finding()] }));
    expect(report.admitted).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it("admits an honestly-empty finding set (ran clean)", () => {
    const report = validate(findingDoc({ findings: [] }));
    expect(report.admitted).toBe(true);
  });

  it("rejects an anchor that is not an offered hunk (V008 — minted identity)", () => {
    const report = validate(findingDoc({ findings: [finding({ anchor: "rennet:hunk/nope" })] }));
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V008");
  });

  it("rejects an empty summary (V130)", () => {
    const report = validate(findingDoc({ findings: [finding({ summary: "   " })] }));
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V130");
  });

  it("rejects an incoherent concur vote — agree exceeds total (V131)", () => {
    const report = validate(
      findingDoc({ findings: [finding({ agreement: { kind: "concur", agree: 3, total: 1 } })] }),
    );
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V131");
  });

  it("rejects a disagreement with fewer than two labelled answers (V131)", () => {
    const report = validate(
      findingDoc({
        findings: [
          finding({
            agreement: { kind: "disagree", answers: [{ model: "Claude", answer: "a leak" }] },
          }),
        ],
      }),
    );
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V131");
  });

  it("rejects a bad severity with a body-shape error (V108)", () => {
    const report = validate(findingDoc({ findings: [finding({ severity: "critical" })] }));
    expect(report.admitted).toBe(false);
    expect(codes(report)).toContain("V108");
  });
});

describe("bodyJsonSchema — finding", () => {
  it("projects a non-null object schema carrying the findings array + agreement", () => {
    const schema = bodyJsonSchema("finding") as Record<string, unknown>;
    expect(schema).not.toBeNull();
    expect(schema.type).toBe("object");
    expect(schema).toHaveProperty("properties");
    // The projection includes the findings collection the model is constrained to.
    expect(JSON.stringify(schema)).toContain("findings");
    expect(JSON.stringify(schema)).toContain("agreement");
  });
});

describe("bodyJsonSchema — the claude CLI compatibility strip", () => {
  it("drops the draft-2020-12 $schema meta-reference the CLI cannot resolve", () => {
    // The `claude` CLI's --json-schema validator rejects a schema whose $schema
    // points at the draft-2020-12 meta-schema. Every projected docType must omit
    // it, or no live structured-output turn can run (the #32 live-turn blocker).
    for (const docType of [
      "decomposition.skeleton",
      "decomposition.proposal",
      "ordering",
      "rollup-narration",
      "finding",
    ] as const) {
      const schema = bodyJsonSchema(docType) as Record<string, unknown>;
      expect(schema).not.toHaveProperty("$schema");
      // The load-bearing shape survives the strip.
      expect(schema.type).toBe("object");
    }
  });
});
