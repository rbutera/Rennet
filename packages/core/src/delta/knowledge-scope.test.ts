import type {
  BaseRefResolution,
  KnowledgeSet,
  KnowledgeStatement,
  WorkspaceScope,
} from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { type LoadedSnapshot, materializeSnapshot } from "../project-context";
import { buildSnapshot, type SnapshotStructuralInputs } from "../project-snapshot";
import { selectPacketKnowledge } from "./knowledge-scope";

// ── A two-package fixture whose import graph has a real 1-hop boundary ────────
//
// `changed.ts` is the patchset. `neighbour.ts` (it imports) and `importer.ts`
// (imports it) are the 1-hop ring. `distant.ts` is TWO hops away — it imports the
// neighbour, never the changed file — and is the file that makes the retrieval
// test able to fail: without it, "everything is in scope" would pass.

const IMPORTS: Record<string, string[]> = {
  "packages/a/src/changed.ts": ["./neighbour"],
  "packages/a/src/neighbour.ts": [],
  "packages/a/src/importer.ts": ["./changed"],
  "packages/a/src/distant.ts": ["./neighbour"],
  "packages/b/src/other.ts": [],
};

const SCOPES: WorkspaceScope[] = [
  { name: "@x/a", root: "packages/a", sourceRoot: "packages/a/src", private: true, tags: [] },
  { name: "@x/b", root: "packages/b", sourceRoot: "packages/b/src", private: true, tags: [] },
];

const CHANGED = ["packages/a/src/changed.ts"];

function blob(path: string): string {
  return `blob:${path}`;
}

/** A materialized snapshot over the fixture. `omitImports` withholds the import shard family. */
function snapshotOf(options: { omitImports?: boolean } = {}): LoadedSnapshot {
  const paths = Object.keys(IMPORTS).sort();
  const inputs: SnapshotStructuralInputs = {
    repoKey: "/repo/.git",
    baseRef: "main",
    baseRefResolution: "symbolic-head" as BaseRefResolution,
    baseOid: "oid-fixture",
    files: paths.map((path) => ({ path, blobOid: blob(path), size: 1, mode: "100644" })),
    scopes: SCOPES,
    edges: [],
    entryPoints: [],
    tests: [],
    ownership: [],
    conventions: [],
  };
  const built = buildSnapshot(
    inputs,
    [],
    [],
    options.omitImports
      ? []
      : paths.map((path) => ({
          blobOid: blob(path),
          extractor: "structural-imports-v1",
          imports: [...(IMPORTS[path] ?? [])].sort(),
        })),
  );
  const materialized = materializeSnapshot(built.manifest, (digest) => built.shards.get(digest));
  if (!materialized.ok) throw new Error(`materialize failed: ${materialized.slots.join(",")}`);
  return materialized.snapshot;
}

function statement(
  id: string,
  subject: string,
  anchorPath: string,
  overrides: Partial<KnowledgeStatement> = {},
): KnowledgeStatement {
  return {
    id,
    subject,
    aspect: "purpose",
    claim: `claim ${id}`,
    evidence: [{ path: anchorPath, blobOid: blob(anchorPath) }],
    confidence: "high",
    status: "hypothesis",
    provenance: { generator: "g@1", model: null, apiKeySource: null },
    learnedAgainst: { baseOid: "oid-fixture", snapshotFingerprint: "fp" },
    ...overrides,
  };
}

const S_NEIGHBOUR = statement(
  "s1-neighbour",
  "packages/a/src/neighbour.ts",
  "packages/a/src/neighbour.ts",
);
const S_IMPORTER = statement(
  "s2-importer",
  "packages/a/src/importer.ts",
  "packages/a/src/importer.ts",
);
const S_DISTANT = statement("s3-distant", "packages/a/src/distant.ts", "packages/a/src/distant.ts");
// Repo-level by SCOPE NAME: `@x/a` is not a path, so a prefix test alone misses it.
const S_SCOPE = statement("s4-scope", "@x/a", "packages/a/src/distant.ts");
// Repo-level by SUBTREE: a directory subject that contains the changed file.
const S_SUBTREE = statement("s5-subtree", "packages/a", "packages/a/src/distant.ts");
// A statement about the OTHER package, anchored there — out of scope by both routes.
const S_OTHER = statement("s6-other", "@x/b", "packages/b/src/other.ts");
// INVALIDATED: anchored on the changed file at a blob the snapshot no longer carries.
const S_INVALID: KnowledgeStatement = {
  ...statement("s7-invalid", "packages/a/src/changed.ts", "packages/a/src/changed.ts"),
  evidence: [{ path: "packages/a/src/changed.ts", blobOid: "blob:stale" }],
};
// REJECTED: a human disowned it. In scope by anchor, and must still never be offered.
const S_REJECTED: KnowledgeStatement = {
  ...statement("s8-rejected", "packages/a/src/changed.ts", "packages/a/src/changed.ts"),
  status: "rejected",
};

const ALL = [
  S_NEIGHBOUR,
  S_IMPORTER,
  S_DISTANT,
  S_SCOPE,
  S_SUBTREE,
  S_OTHER,
  S_INVALID,
  S_REJECTED,
];

const SET: KnowledgeSet = {
  schemaVersion: 1,
  repoKey: "-repo",
  baseOid: "oid-fixture",
  snapshotFingerprint: "fp",
  generator: "g@1",
  statements: ALL,
};

const ids = (statements: readonly KnowledgeStatement[]): string[] => statements.map((s) => s.id);

describe("selectPacketKnowledge — the fixture carries the shapes the rules turn on", () => {
  // Not a tautology check: three of the assertions below are the only reason the
  // projection and retrieval tests CAN fail. A single-package, all-current,
  // all-in-scope fixture would let a no-op implementation pass every one of them.
  it("holds a rejected, an invalidated, an out-of-scope and a repo-level statement", () => {
    expect(ALL.some((s) => s.status === "rejected")).toBe(true);
    expect(S_INVALID.evidence[0]?.blobOid).not.toBe(blob("packages/a/src/changed.ts"));
    expect(ids(ALL)).toContain(S_DISTANT.id);
    expect(SCOPES.some((scope) => scope.name === S_SCOPE.subject)).toBe(true);
  });

  it("the import graph really separates the 1-hop ring from the 2-hop file", () => {
    const selection = selectPacketKnowledge({
      set: SET,
      snapshot: snapshotOf(),
      changedPaths: CHANGED,
    });
    // changed + neighbour + importer, and NOT distant/other.
    expect(selection.counts.scopeFiles).toBe(3);
    expect(selection.mode).toBe("import-graph");
  });
});

describe("selectPacketKnowledge — projection (the defect this fixes)", () => {
  const selection = selectPacketKnowledge({
    set: SET,
    snapshot: snapshotOf(),
    changedPaths: CHANGED,
  });

  it("discloses an invalidated statement as PENDING rather than serving it as current", () => {
    expect(ids(selection.statements)).not.toContain(S_INVALID.id);
    expect(ids(selection.invalidatedPending)).toEqual([S_INVALID.id]);
  });

  it("DROPS a rejected statement from both lists, and says how many it dropped", () => {
    expect(ids(selection.statements)).not.toContain(S_REJECTED.id);
    expect(ids(selection.invalidatedPending)).not.toContain(S_REJECTED.id);
    expect(selection.counts.rejected).toBe(1);
  });

  it("reports the whole store size, so a drafter knows more exists than it was handed", () => {
    expect(selection.counts.inStore).toBe(ALL.length);
    expect(selection.statements.length).toBeLessThan(selection.counts.inStore);
    expect(selection.note).toContain("context.ask");
  });
});

describe("selectPacketKnowledge — retrieval scope", () => {
  const selection = selectPacketKnowledge({
    set: SET,
    snapshot: snapshotOf(),
    changedPaths: CHANGED,
  });

  it("includes a 1-hop neighbour, both directions", () => {
    expect(ids(selection.statements)).toContain(S_NEIGHBOUR.id);
    expect(ids(selection.statements)).toContain(S_IMPORTER.id);
  });

  it("EXCLUDES a statement anchored two hops out", () => {
    expect(ids(selection.statements)).not.toContain(S_DISTANT.id);
  });

  it("includes repo-level statements by scope NAME and by path subtree", () => {
    // Both are anchored on the out-of-scope `distant.ts`, so only the subject rule
    // can be letting them in — the anchor rule would have excluded them.
    expect(ids(selection.statements)).toContain(S_SCOPE.id);
    expect(ids(selection.statements)).toContain(S_SUBTREE.id);
  });

  it("excludes another package's statement — 'repo-level' is not 'everything'", () => {
    expect(ids(selection.statements)).not.toContain(S_OTHER.id);
  });
});

describe("selectPacketKnowledge — the cap discloses what it dropped", () => {
  it("offers `cap` statements and reports the rest as truncated", () => {
    const uncapped = selectPacketKnowledge({
      set: SET,
      snapshot: snapshotOf(),
      changedPaths: CHANGED,
    });
    expect(uncapped.counts.truncated).toBe(0);
    expect(uncapped.counts.currentInScope).toBeGreaterThan(1);

    const capped = selectPacketKnowledge({
      set: SET,
      snapshot: snapshotOf(),
      changedPaths: CHANGED,
      cap: 1,
    });
    expect(capped.statements).toHaveLength(1);
    // The in-scope total is unchanged by the cap — the cap hides statements, it
    // never makes the packet claim there were fewer to begin with.
    expect(capped.counts.currentInScope).toBe(uncapped.counts.currentInScope);
    expect(capped.counts.truncated).toBe(uncapped.counts.currentInScope - 1);
  });

  it("orders deterministically by statement id, so the cap keeps a stable prefix", () => {
    const first = selectPacketKnowledge({
      set: SET,
      snapshot: snapshotOf(),
      changedPaths: CHANGED,
    });
    const second = selectPacketKnowledge({
      set: { ...SET, statements: [...ALL].reverse() },
      snapshot: snapshotOf(),
      changedPaths: CHANGED,
    });
    expect(ids(second.statements)).toEqual(ids(first.statements));
    expect(ids(first.statements)).toEqual([...ids(first.statements)].sort());
  });
});

describe("selectPacketKnowledge — degradation is toward MORE, and it is disclosed", () => {
  it("no import graph ⇒ the FULL projected set, marked `projected-full`", () => {
    const degraded = selectPacketKnowledge({
      set: SET,
      snapshot: snapshotOf({ omitImports: true }),
      changedPaths: CHANGED,
    });
    expect(degraded.mode).toBe("projected-full");
    // The 2-hop statement the scoped mode excluded is now offered — never less.
    expect(ids(degraded.statements)).toContain(S_DISTANT.id);
    expect(ids(degraded.statements)).toContain(S_OTHER.id);
    // Projection still holds: rejected dropped, invalidated disclosed as pending.
    expect(ids(degraded.statements)).not.toContain(S_REJECTED.id);
    expect(ids(degraded.invalidatedPending)).toEqual([S_INVALID.id]);
    expect(degraded.counts.scopeFiles).toBe(0);
  });

  it("no snapshot ⇒ `unprojected`, saying invalidation could not be checked", () => {
    const degraded = selectPacketKnowledge({ set: SET, snapshot: null, changedPaths: CHANGED });
    expect(degraded.mode).toBe("unprojected");
    expect(degraded.note).toContain("UNPROJECTED");
    // Rejection needs no snapshot, so it is still honoured.
    expect(ids(degraded.statements)).not.toContain(S_REJECTED.id);
    expect(degraded.counts.rejected).toBe(1);
    // Nothing can be called pending without anchors to resolve — and the
    // invalidated statement is NOT quietly filed as current-and-fine either: it
    // sits in `statements` under a mode that says the check did not happen.
    expect(degraded.invalidatedPending).toEqual([]);
    expect(ids(degraded.statements)).toContain(S_INVALID.id);
  });

  it("no set at all ⇒ an honest empty selection, not a crash", () => {
    const empty = selectPacketKnowledge({
      set: null,
      snapshot: snapshotOf(),
      changedPaths: CHANGED,
    });
    expect(empty.statements).toEqual([]);
    expect(empty.counts.inStore).toBe(0);
    expect(empty.generator).toBeNull();
  });
});
