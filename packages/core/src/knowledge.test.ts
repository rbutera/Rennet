import type {
  KnowledgeSet,
  KnowledgeStatement,
  ProjectSnapshotManifest,
  SnapshotFileEntry,
} from "@rennet/types";
import { describe, expect, it } from "vitest";
import {
  anchorResolves,
  fileBlobIndex,
  knowledgeStatementId,
  queryKnowledge,
  statementResolves,
  validateKnowledgeAnchor,
  validateKnowledgeSet,
  validateKnowledgeStatement,
} from "./knowledge";
import type { LoadedSnapshot } from "./project-context";

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
