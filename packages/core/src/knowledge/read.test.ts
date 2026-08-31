import type {
  KnowledgeCoverage,
  KnowledgeSet,
  KnowledgeStatement,
  ProjectSnapshotManifest,
  SnapshotFileEntry,
} from "@rennet/protocol";
import { KNOWLEDGE_SWARM_GENERATOR_ID } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import type { LoadedSnapshot } from "../project-context";
import { partitionsFromSnapshot } from "./partition";
import {
  anchorResolves,
  fileBlobIndex,
  knowledgeCoverageTotals,
  knowledgeStatementId,
  queryKnowledge,
  statementResolves,
  validateKnowledgeAnchor,
  validateKnowledgeCoverage,
  validateKnowledgeSet,
  validateKnowledgeStatement,
} from "./read";
import { MAP_SCOPE_GENERATOR_ID, materializeKnowledgeCoverage } from "./scope";

function file(path: string, blobOid: string): SnapshotFileEntry {
  return { path, blobOid, size: 1, mode: "100644" };
}

function loadedSnapshot(files: readonly SnapshotFileEntry[]): LoadedSnapshot {
  const manifest: ProjectSnapshotManifest = {
    schemaVersion: 1,
    repoKey: "-repo",
    baseRef: "refs/heads/main",
    baseRefResolution: "symbolic-head",
    baseOid: "oid-current",
    fingerprint: "fp-current",
    shards: {} as ProjectSnapshotManifest["shards"],
    symbols: [],
    references: [],
    imports: [],
  };
  return {
    manifest,
    files,
    scopes: [],
    edges: [],
    entryPoints: [],
    tests: [],
    ownership: [],
    conventions: [],
    symbolDigestByBlob: new Map(),
    referenceDigestByBlob: new Map(),
    importDigestByBlob: new Map(),
    load: () => undefined,
  };
}

function statement(overrides: Partial<KnowledgeStatement> = {}): KnowledgeStatement {
  const evidence = overrides.evidence ?? [{ path: "packages/a/src/index.ts", blobOid: "blob-a" }];
  return {
    id: overrides.id ?? "id-1",
    subject: overrides.subject ?? "@t/a",
    aspect: overrides.aspect ?? "purpose",
    claim: overrides.claim ?? "does a thing",
    evidence,
    confidence: overrides.confidence ?? "high",
    status: overrides.status ?? "hypothesis",
    provenance: overrides.provenance ?? { generator: "g@1", model: null, apiKeySource: null },
    learnedAgainst: overrides.learnedAgainst ?? {
      baseOid: "oid-current",
      snapshotFingerprint: "fp-current",
    },
  };
}

function set(statements: readonly KnowledgeStatement[]): KnowledgeSet {
  return {
    schemaVersion: 1,
    repoKey: "-repo",
    baseOid: "oid-current",
    snapshotFingerprint: "fp-current",
    generator: "g@1",
    statements,
  };
}

function coverage(): KnowledgeCoverage {
  return {
    schemaVersion: 1,
    catalogueDigest: "catalogue-digest",
    selector: {
      kind: "council",
      cap: 64,
      generator: "map-scope@1",
      harness: "codex",
      assignedModel: "gpt-5.6-terra",
      model: "gpt-5.6-terra",
      effort: "medium",
      apiKeySource: null,
    },
    groups: [
      {
        kind: "mapped",
        sliceId: "mod:a.ts#1",
        files: [{ path: "a.ts", blobOid: "a" }],
      },
      {
        kind: "excluded",
        source: "scope",
        sliceId: "dir:docs",
        reason: "Repeated reference material",
        files: [{ path: "docs/a.md", blobOid: "docs" }],
      },
      {
        kind: "excluded",
        source: "mechanical",
        reason: "lockfile",
        files: [{ path: "pnpm-lock.yaml", blobOid: "lock" }],
      },
    ],
  };
}

function exactCoverageFor(snapshot: LoadedSnapshot): KnowledgeCoverage {
  const candidates = partitionsFromSnapshot(snapshot);
  return materializeKnowledgeCoverage({
    snapshot,
    candidates,
    selection: {
      status: "ok",
      includedSliceIds: candidates.map((candidate) => candidate.id),
      excludedSlices: [],
      provenance: { generator: MAP_SCOPE_GENERATOR_ID, model: null, apiKeySource: null },
      attempts: 0,
    },
    selector: { kind: "below-cap" },
  });
}

describe("validateKnowledgeAnchor", () => {
  it("requires a safe path and a blobOid", () => {
    expect(validateKnowledgeAnchor({ path: "a/b.ts", blobOid: "x" })).toEqual({
      path: "a/b.ts",
      blobOid: "x",
    });
    expect(validateKnowledgeAnchor({ path: "../escape.ts", blobOid: "x" })).toBeUndefined();
    expect(validateKnowledgeAnchor({ path: "a/b.ts" })).toBeUndefined();
    expect(validateKnowledgeAnchor({ blobOid: "x" })).toBeUndefined();
  });

  it("keeps optional symbol + a well-formed line span, rejects a malformed one", () => {
    expect(
      validateKnowledgeAnchor({ path: "a.ts", blobOid: "x", symbol: "f", lines: { startLine: 3 } }),
    ).toEqual({ path: "a.ts", blobOid: "x", symbol: "f", lines: { startLine: 3 } });
    expect(
      validateKnowledgeAnchor({ path: "a.ts", blobOid: "x", lines: { startLine: 0 } }),
    ).toBeUndefined();
  });
});

describe("validateKnowledgeStatement", () => {
  it("accepts a well-formed statement", () => {
    expect(validateKnowledgeStatement(statement())).not.toBeUndefined();
  });

  it("rejects an UNANCHORED statement (zero evidence) — invalid, never served", () => {
    expect(validateKnowledgeStatement(statement({ evidence: [] }))).toBeUndefined();
  });

  it("rejects a bad enum (aspect/confidence/status) or a bad anchor", () => {
    expect(validateKnowledgeStatement({ ...statement(), aspect: "vibes" })).toBeUndefined();
    expect(validateKnowledgeStatement({ ...statement(), confidence: "certain" })).toBeUndefined();
    expect(
      validateKnowledgeStatement({ ...statement(), evidence: [{ path: "../x", blobOid: "y" }] }),
    ).toBeUndefined();
  });
});

describe("validateKnowledgeSet", () => {
  it("drops malformed statements but keeps the good ones", () => {
    const validated = validateKnowledgeSet({
      ...set([statement({ id: "ok" })]),
      statements: [
        statement({ id: "ok" }),
        { garbage: true },
        statement({ id: "ok2", evidence: [] }),
      ],
    });
    expect(validated?.statements.map((s) => s.id)).toEqual(["ok"]);
  });

  it("rejects a set with malformed identity pins", () => {
    expect(validateKnowledgeSet({ ...set([]), baseOid: 123 })).toBeUndefined();
  });

  it("keeps a rejected statement — a human disposition must survive persistence", () => {
    const validated = validateKnowledgeSet(set([statement({ id: "r", status: "rejected" })]));
    expect(validated?.statements.map((s) => s.status)).toEqual(["rejected"]);
  });

  it("keeps exact coverage and rejects a malformed present coverage claim whole", () => {
    expect(validateKnowledgeSet({ ...set([]), coverage: coverage() })?.coverage).toEqual(
      coverage(),
    );
    expect(
      validateKnowledgeSet({
        ...set([]),
        coverage: {
          ...coverage(),
          groups: [
            ...coverage().groups,
            {
              kind: "mapped",
              sliceId: "duplicate-path",
              files: [{ path: "a.ts", blobOid: "a" }],
            },
          ],
        },
      }),
    ).toBeUndefined();
  });

  it("rejects a current swarm set that omits its mandatory exact coverage", () => {
    expect(
      validateKnowledgeSet({ ...set([]), generator: KNOWLEDGE_SWARM_GENERATOR_ID }),
    ).toBeUndefined();
    expect(validateKnowledgeSet({ ...set([]), generator: "knowledge-swarm@4" })).toBeDefined();
  });
});

describe("validateKnowledgeCoverage", () => {
  it("accepts one exact partition and rejects unknown fields or unsafe paths", () => {
    expect(validateKnowledgeCoverage(coverage())).toEqual(coverage());
    expect(validateKnowledgeCoverage({ ...coverage(), invented: true })).toBeUndefined();
    expect(
      validateKnowledgeCoverage({
        ...coverage(),
        groups: [
          {
            kind: "mapped",
            sliceId: "escape",
            files: [{ path: "../escape.ts", blobOid: "x" }],
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("rejects duplicate slice ids and duplicate mechanical reason groups", () => {
    const valid = coverage();
    const mapped = valid.groups[0] as KnowledgeCoverage["groups"][number];
    const mechanical = valid.groups[2] as KnowledgeCoverage["groups"][number];
    expect(
      validateKnowledgeCoverage({
        ...valid,
        groups: [mapped, { ...mapped, files: [{ path: "b.ts", blobOid: "b" }] }],
      }),
    ).toBeUndefined();
    expect(
      validateKnowledgeCoverage({
        ...valid,
        groups: [
          mechanical,
          { ...mechanical, files: [{ path: "package-lock.json", blobOid: "other-lock" }] },
        ],
      }),
    ).toBeUndefined();
  });

  it("rejects unknown council assignments and assignments owned by the other harness", () => {
    const valid = coverage();
    if (valid.selector.kind !== "council") throw new Error("fixture");
    expect(
      validateKnowledgeCoverage({
        ...valid,
        selector: { ...valid.selector, assignedModel: "gpt-4o" },
      }),
    ).toBeUndefined();
    expect(
      validateKnowledgeCoverage({
        ...valid,
        selector: { ...valid.selector, harness: "claude-code" },
      }),
    ).toBeUndefined();
  });
});

describe("knowledgeStatementId", () => {
  it("is stable and order-independent over anchors", () => {
    const a = knowledgeStatementId({
      subject: "s",
      aspect: "purpose",
      claim: "c",
      evidence: [
        { path: "a.ts", blobOid: "1" },
        { path: "b.ts", blobOid: "2" },
      ],
    });
    const b = knowledgeStatementId({
      subject: "s",
      aspect: "purpose",
      claim: "c",
      evidence: [
        { path: "b.ts", blobOid: "2" },
        { path: "a.ts", blobOid: "1" },
      ],
    });
    expect(a).toBe(b);
    // A different claim ⇒ a different id.
    expect(
      knowledgeStatementId({
        subject: "s",
        aspect: "purpose",
        claim: "d",
        evidence: [{ path: "a.ts", blobOid: "1" }],
      }),
    ).not.toBe(a);
  });
});

describe("anchor resolution", () => {
  const index = fileBlobIndex([file("a.ts", "1"), file("b.ts", "2")]);

  it("resolves iff the cited bytes still live at that path", () => {
    expect(anchorResolves({ path: "a.ts", blobOid: "1" }, index)).toBe(true);
    expect(anchorResolves({ path: "a.ts", blobOid: "999" }, index)).toBe(false);
    expect(anchorResolves({ path: "gone.ts", blobOid: "1" }, index)).toBe(false);
  });

  it("statementResolves requires EVERY anchor to resolve", () => {
    expect(
      statementResolves(
        statement({
          evidence: [
            { path: "a.ts", blobOid: "1" },
            { path: "b.ts", blobOid: "2" },
          ],
        }),
        index,
      ),
    ).toBe(true);
    expect(
      statementResolves(
        statement({
          evidence: [
            { path: "a.ts", blobOid: "1" },
            { path: "b.ts", blobOid: "CHANGED" },
          ],
        }),
        index,
      ),
    ).toBe(false);
  });
});

describe("queryKnowledge", () => {
  it("returns an empty view for a null set (not-yet-enriched, honest absence)", () => {
    const view = queryKnowledge(null, loadedSnapshot([file("a.ts", "1")]));
    expect(view.generator).toBeNull();
    expect(view.statements).toEqual([]);
    expect(view.invalidatedPending).toEqual([]);
    expect(view.baseOid).toBe("oid-current");
    expect(view.coverage).toEqual({ kind: "absent" });
  });

  it("distinguishes legacy unrecorded coverage from a current exact coverage record", () => {
    const snapshot = loadedSnapshot([
      file("a.ts", "a"),
      file("docs/a.md", "docs"),
      file("pnpm-lock.yaml", "lock"),
    ]);
    expect(queryKnowledge(set([]), snapshot).coverage).toEqual({ kind: "unrecorded" });
    const exact = exactCoverageFor(snapshot);
    expect(queryKnowledge({ ...set([]), coverage: exact }, snapshot).coverage).toEqual({
      kind: "current",
      exact,
    });
  });

  it("does not present a current-generator set without mandatory coverage as legacy", () => {
    const snapshot = loadedSnapshot([file("a.ts", "a")]);
    expect(
      queryKnowledge({ ...set([]), generator: KNOWLEDGE_SWARM_GENERATOR_ID }, snapshot).coverage,
    ).toEqual({ kind: "invalid", reason: "required-coverage-missing" });
  });

  it("marks matching-identity coverage invalid when it omits a snapshot file", () => {
    const snapshot = loadedSnapshot([
      file("a.ts", "a"),
      file("docs/a.md", "docs"),
      file("pnpm-lock.yaml", "lock"),
    ]);
    const valid = exactCoverageFor(snapshot);
    const exact: KnowledgeCoverage = { ...valid, groups: valid.groups.slice(0, -1) };
    expect(queryKnowledge({ ...set([]), coverage: exact }, snapshot).coverage).toEqual({
      kind: "invalid",
      reason: "inventory-mismatch",
    });
  });

  it("marks matching-identity coverage invalid when it claims the wrong blob", () => {
    const snapshot = loadedSnapshot([
      file("a.ts", "a"),
      file("docs/a.md", "docs"),
      file("pnpm-lock.yaml", "lock"),
    ]);
    const valid = exactCoverageFor(snapshot);
    const [first, ...rest] = valid.groups;
    if (first?.kind !== "mapped") throw new Error("fixture");
    const exact: KnowledgeCoverage = {
      ...valid,
      groups: [{ ...first, files: [{ path: "a.ts", blobOid: "wrong" }] }, ...rest],
    };
    expect(queryKnowledge({ ...set([]), coverage: exact }, snapshot).coverage).toEqual({
      kind: "invalid",
      reason: "inventory-mismatch",
    });
  });

  it("marks matching-identity coverage invalid when it invents a slice id", () => {
    const snapshot = loadedSnapshot([
      file("a.ts", "a"),
      file("docs/a.md", "docs"),
      file("pnpm-lock.yaml", "lock"),
    ]);
    const valid = exactCoverageFor(snapshot);
    const [first, ...rest] = valid.groups;
    if (first?.kind !== "mapped") throw new Error("fixture");
    const exact: KnowledgeCoverage = {
      ...valid,
      selector: {
        kind: "council",
        cap: 64,
        generator: MAP_SCOPE_GENERATOR_ID,
        harness: "codex",
        assignedModel: "gpt-5.6-terra",
        model: "gpt-5.6-terra",
        effort: "medium",
        apiKeySource: null,
      },
      groups: [{ ...first, sliceId: "invented-slice" }, ...rest],
    };
    expect(queryKnowledge({ ...set([]), coverage: exact }, snapshot).coverage).toEqual({
      kind: "invalid",
      reason: "inventory-mismatch",
    });
  });

  it("marks a Council selector invalid when the candidate catalogue is still below its cap", () => {
    const snapshot = loadedSnapshot([
      file("a.ts", "a"),
      file("docs/a.md", "docs"),
      file("pnpm-lock.yaml", "lock"),
    ]);
    const valid = exactCoverageFor(snapshot);
    const exact: KnowledgeCoverage = {
      ...valid,
      selector: {
        kind: "council",
        cap: 64,
        generator: MAP_SCOPE_GENERATOR_ID,
        harness: "codex",
        assignedModel: "gpt-5.6-terra",
        model: "gpt-5.6-terra",
        effort: "medium",
        apiKeySource: null,
      },
    };
    expect(queryKnowledge({ ...set([]), coverage: exact }, snapshot).coverage).toEqual({
      kind: "invalid",
      reason: "inventory-mismatch",
    });
  });

  it("marks a below-cap record invalid when it excludes an eligible slice", () => {
    const snapshot = loadedSnapshot([
      file("a.ts", "a"),
      file("docs/a.md", "docs"),
      file("pnpm-lock.yaml", "lock"),
    ]);
    const valid = exactCoverageFor(snapshot);
    const [first, ...rest] = valid.groups;
    if (first?.kind !== "mapped") throw new Error("fixture");
    const exact: KnowledgeCoverage = {
      ...valid,
      groups: [
        {
          kind: "excluded",
          source: "scope",
          sliceId: first.sliceId,
          reason: "Incorrectly excluded below the cap",
          files: first.files,
        },
        ...rest,
      ],
    };
    expect(queryKnowledge({ ...set([]), coverage: exact }, snapshot).coverage).toEqual({
      kind: "invalid",
      reason: "inventory-mismatch",
    });
  });

  it("keeps exact coverage but marks it stale when it belongs to another snapshot", () => {
    const snapshot = loadedSnapshot([file("a.ts", "a")]);
    expect(
      queryKnowledge(
        { ...set([]), snapshotFingerprint: "fp-earlier", coverage: coverage() },
        snapshot,
      ).coverage,
    ).toEqual({
      kind: "stale",
      exact: coverage(),
      learnedAgainst: { baseOid: "oid-current", snapshotFingerprint: "fp-earlier" },
    });
  });

  it("serves statements whose anchors resolve as `current`, verbatim + labelled", () => {
    const snap = loadedSnapshot([file("packages/a/src/index.ts", "blob-a")]);
    const view = queryKnowledge(set([statement()]), snap);
    expect(view.statements).toHaveLength(1);
    expect(view.statements[0]?.status).toBe("hypothesis");
    expect(view.invalidatedPending).toEqual([]);
  });

  it("discloses a statement whose cited bytes CHANGED as invalidated-pending (never dropped)", () => {
    // The snapshot advanced: the cited file now carries a different blob.
    const snap = loadedSnapshot([file("packages/a/src/index.ts", "blob-a-v2")]);
    const view = queryKnowledge(set([statement({ id: "stale" })]), snap);
    expect(view.statements).toEqual([]);
    expect(view.invalidatedPending.map((s) => s.id)).toEqual(["stale"]);
  });

  it("filters by subject/aspect/path", () => {
    const snap = loadedSnapshot([
      file("packages/a/src/index.ts", "blob-a"),
      file("packages/b/x.ts", "blob-b"),
    ]);
    const s = set([
      statement({ id: "a-purpose", subject: "@t/a", aspect: "purpose" }),
      statement({
        id: "b-why",
        subject: "@t/b",
        aspect: "why",
        evidence: [{ path: "packages/b/x.ts", blobOid: "blob-b" }],
      }),
    ]);
    expect(queryKnowledge(s, snap, { aspect: "why" }).statements.map((x) => x.id)).toEqual([
      "b-why",
    ]);
    expect(queryKnowledge(s, snap, { path: "packages/b" }).statements.map((x) => x.id)).toEqual([
      "b-why",
    ]);
    expect(queryKnowledge(s, snap, { subject: "@t/a" }).statements.map((x) => x.id)).toEqual([
      "a-purpose",
    ]);
  });
});

describe("knowledgeCoverageTotals", () => {
  it("reports mapped, scope-excluded, and mechanically excluded files separately", () => {
    expect(knowledgeCoverageTotals(coverage())).toEqual({
      mappedFiles: 1,
      mappedSlices: 1,
      scopeExcludedFiles: 1,
      scopeExcludedSlices: 1,
      mechanicallyExcludedFiles: 1,
    });
  });
});
