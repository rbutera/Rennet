import type {
  BaseRefResolution,
  KnowledgeCoverage,
  KnowledgeSet,
  KnowledgeStatement,
  WorkspaceScope,
} from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { partitionsFromSnapshot } from "../knowledge/partition";
import { MAP_SCOPE_GENERATOR_ID, materializeKnowledgeCoverage } from "../knowledge/scope";
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
  "pnpm-lock.yaml": [],
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
function snapshotOf(
  options: { omitImports?: boolean; scopes?: WorkspaceScope[] } = {},
): LoadedSnapshot {
  const paths = Object.keys(IMPORTS).sort();
  const inputs: SnapshotStructuralInputs = {
    repoKey: "/repo/.git",
    baseRef: "main",
    baseRefResolution: "symbolic-head" as BaseRefResolution,
    baseOid: "oid-fixture",
    files: paths.map((path) => ({ path, blobOid: blob(path), size: 1, mode: "100644" })),
    scopes: options.scopes ?? SCOPES,
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

function fixtureCoverage(snapshot: LoadedSnapshot): KnowledgeCoverage {
  const candidates = partitionsFromSnapshot(snapshot);
  return materializeKnowledgeCoverage({
    snapshot,
    candidates,
    selection: {
      status: "ok",
      includedSliceIds: candidates.map((candidate) => candidate.id),
      excludedSlices: [],
      provenance: {
        generator: MAP_SCOPE_GENERATOR_ID,
        model: null,
        apiKeySource: null,
      },
      attempts: 0,
    },
    selector: { kind: "below-cap" },
  });
}

function wideSnapshotOf(): LoadedSnapshot {
  const scopes = Array.from({ length: 65 }, (_, index) => {
    const suffix = index.toString().padStart(2, "0");
    return {
      name: `@wide/p${suffix}`,
      root: `packages/p${suffix}`,
      sourceRoot: `packages/p${suffix}/src`,
      private: true,
      tags: [],
    } satisfies WorkspaceScope;
  });
  const inputs: SnapshotStructuralInputs = {
    repoKey: "/wide/.git",
    baseRef: "main",
    baseRefResolution: "symbolic-head",
    baseOid: "oid-wide",
    files: scopes.map((scope) => ({
      path: `${scope.sourceRoot}/index.ts`,
      blobOid: blob(`${scope.sourceRoot}/index.ts`),
      size: 1,
      mode: "100644",
    })),
    scopes,
    edges: [],
    entryPoints: [],
    tests: [],
    ownership: [],
    conventions: [],
  };
  const built = buildSnapshot(inputs, []);
  const materialized = materializeSnapshot(built.manifest, (digest) => built.shards.get(digest));
  if (!materialized.ok) throw new Error(`materialize failed: ${materialized.slots.join(",")}`);
  return materialized.snapshot;
}

function wideCoverage(snapshot: LoadedSnapshot): KnowledgeCoverage {
  const candidates = partitionsFromSnapshot(snapshot);
  if (candidates.length <= 64) throw new Error("wide fixture did not exceed the selector cap");
  return materializeKnowledgeCoverage({
    snapshot,
    candidates,
    selection: {
      status: "ok",
      includedSliceIds: candidates.slice(0, 64).map((candidate) => candidate.id),
      excludedSlices: candidates.slice(64).map((candidate) => ({
        sliceId: candidate.id,
        reason: "Outside the selected mapping slices",
      })),
      provenance: {
        generator: MAP_SCOPE_GENERATOR_ID,
        model: "gpt-5.6-terra",
        apiKeySource: null,
      },
      attempts: 1,
    },
    selector: {
      kind: "council",
      harness: "codex",
      assignedModel: "gpt-5.6-terra",
      model: "gpt-5.6-terra",
      effort: "medium",
      apiKeySource: null,
    },
  });
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
  snapshotFingerprint: snapshotOf().manifest.fingerprint,
  generator: "g@1",
  coverage: fixtureCoverage(snapshotOf()),
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

  it("discloses the map-generation coverage that frames the selected statements", () => {
    expect(selection.coverage).toEqual({
      kind: "current",
      mappedFiles: 5,
      mappedSlices: 2,
      scopeExcludedFiles: 0,
      scopeExcludedSlices: 0,
      mechanicallyExcludedFiles: 1,
    });
    expect(selection.note).toContain("0 scope-excluded");
    expect(selection.note).toContain("1 mechanically excluded");
  });

  it("discloses exact scope exclusions from a valid above-cap selector", () => {
    const snapshot = wideSnapshotOf();
    const coverage = wideCoverage(snapshot);
    const selection = selectPacketKnowledge({
      set: {
        ...SET,
        baseOid: snapshot.manifest.baseOid,
        snapshotFingerprint: snapshot.manifest.fingerprint,
        coverage,
        statements: [],
      },
      snapshot,
      changedPaths: [snapshot.files[0]?.path ?? ""],
    });
    expect(selection.coverage.kind).toBe("current");
    if (selection.coverage.kind !== "current") throw new Error("unreachable");
    expect(selection.coverage.scopeExcludedFiles).toBeGreaterThan(0);
    expect(selection.note).toContain(`${selection.coverage.scopeExcludedFiles} scope-excluded`);
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

  // Scope names are NOT unique (`partition.ts` handles duplicates), so the
  // scope-name route must consider EVERY root carrying the name. Taking the first
  // match answers for whichever root the table happened to list first — the
  // many-repos-one-identity failure, one level down.
  it("a DUPLICATE scope name resolves through the root that really holds the change", () => {
    const scopes: WorkspaceScope[] = [
      // The DECOY, named identically and holding nothing that changed. The snapshot
      // sorts its scope table by root, so `docs` lands FIRST — which is where a
      // first-match lookup stops, and why this fixture can catch one.
      { name: "@dup", root: "docs", sourceRoot: "docs", private: true, tags: [] },
      { name: "@dup", root: "packages/a", sourceRoot: "packages/a/src", private: true, tags: [] },
    ];
    // Anchored on the two-hop `distant.ts`, so ONLY the subject rule can admit it.
    const dup = statement("s9-dup", "@dup", "packages/a/src/distant.ts");
    const picked = selectPacketKnowledge({
      set: { ...SET, statements: [...ALL, dup] },
      snapshot: snapshotOf({ scopes }),
      changedPaths: CHANGED,
    });
    expect(picked.mode).toBe("import-graph");
    // The table really is ordered decoy-first, so first-match would answer `docs`.
    expect(picked.statements.length).toBeGreaterThan(0);
    expect(ids(picked.statements)).toContain(dup.id);
  });

  // The two subject namespaces are INDEPENDENT, and neither may bypass the other's
  // rule: a scope NAME resolves through its declared root (never its spelling), and a
  // path subtree stays a subtree claim even when some scope is named like it.
  it("the scope-name route gates on the ROOT; the path route stays independent", () => {
    const scopes: WorkspaceScope[] = [
      // `@x/a` now roots at packages/b — it no longer holds the change.
      { name: "@x/a", root: "packages/b", sourceRoot: "packages/b/src", private: true, tags: [] },
      // ...and a PATH-LIKE scope name, also rooted away from the change.
      {
        name: "packages/a",
        root: "packages/b",
        sourceRoot: "packages/b/src",
        private: true,
        tags: [],
      },
    ];
    const picked = selectPacketKnowledge({
      set: SET,
      snapshot: snapshotOf({ scopes }),
      changedPaths: CHANGED,
    });
    // The base fixture admits S_SCOPE through `@x/a`'s root; re-rooted, it must NOT
    // be admitted — the route is the root, not the name matching something.
    expect(ids(picked.statements)).not.toContain(S_SCOPE.id);
    // S_SUBTREE's subject IS the changed file's subtree, so the path route still
    // admits it — a namesake scope rooted elsewhere does not veto a subtree claim.
    expect(ids(picked.statements)).toContain(S_SUBTREE.id);
  });
});

// ── The graph must cover the CHANGE, not merely exist (Y2) ────────────────────
//
// One resolved edge anywhere in the repo is not evidence that the graph can answer
// about these changed paths. When it cannot, the scope collapses to the changed
// paths themselves and silently discards the rest of the store — under a `mode`
// claiming a confident scoped selection. Coverage of the change is the gate.

describe("selectPacketKnowledge — scoped mode requires the graph to cover the change", () => {
  it("changed paths with NO edges ⇒ projected-full, even though the repo graph has edges", () => {
    // `packages/b/src/other.ts` imports nothing and nothing imports it, while
    // `packages/a` is full of resolved edges. The old rule (any edge in the repo)
    // gave `import-graph` here — control-proven: restore `graph.edges.length > 0`
    // as the sole gate and this assertion reds.
    const selection = selectPacketKnowledge({
      set: SET,
      snapshot: snapshotOf(),
      changedPaths: ["packages/b/src/other.ts"],
    });
    expect(selection.mode).toBe("projected-full");
    expect(selection.counts.changedPathsWithEdges).toBe(0);
    // Present at base, just isolated — which is the distinction the disclosure draws.
    expect(selection.counts.changedPathsAtBase).toBe(1);
    // Degradation is toward MORE: nothing was discarded for being out of a scope
    // that could not be computed.
    expect(ids(selection.statements)).toContain(S_DISTANT.id);
  });

  it("an ADDED file the base never carried ⇒ projected-full, and the counts say why", () => {
    const selection = selectPacketKnowledge({
      set: SET,
      snapshot: snapshotOf(),
      changedPaths: ["packages/a/src/brand-new.ts"],
    });
    expect(selection.mode).toBe("projected-full");
    // The added-file signature: not at base at all, so "no dependencies" was never
    // the finding — the base could not be asked.
    expect(selection.counts.changedPaths).toBe(1);
    expect(selection.counts.changedPathsAtBase).toBe(0);
    expect(selection.counts.changedPathsWithEdges).toBe(0);
    expect(selection.note).toContain("0 of 1 changed path(s) carry a resolved import edge");
    expect(selection.note).toContain("0 of 1 exist at the base snapshot");
  });

  it("the import shard being unavailable is its own disclosed reason", () => {
    // A loader that can no longer produce the import shards the manifest names ⇒
    // `queryImportGraph` refuses, which is a DIFFERENT story from a graph that
    // resolved and found nothing. Both degrade to the full set; only the note says which.
    const broken: LoadedSnapshot = { ...snapshotOf(), load: () => undefined };
    const selection = selectPacketKnowledge({
      set: SET,
      snapshot: broken,
      changedPaths: CHANGED,
    });
    expect(selection.mode).toBe("projected-full");
    expect(selection.note).toContain("import shard unavailable");
    expect(selection.note).not.toContain("no resolved import edges");
  });

  it("no import shards at all reads as 'no resolved import edges', not as unavailable", () => {
    const selection = selectPacketKnowledge({
      set: SET,
      snapshot: snapshotOf({ omitImports: true }),
      changedPaths: CHANGED,
    });
    expect(selection.note).toContain("no resolved import edges");
    expect(selection.note).not.toContain("import shard unavailable");
  });
});

// ── Degradation stays monotone UNDER THE CAP (Y4) ─────────────────────────────
//
// "Degrade toward more" is a claim about what the drafter is HANDED, not about the
// pool the cap is taken from. With more statements than the cap, a plain id sort
// lets low-id irrelevant rows evict every row the scoped mode would have kept, so
// the wider mode hands over strictly less useful evidence while reporting a wider
// mode. The unscoped modes therefore order the 0-hop change-relevant band first.
//
// The protection is the 0-HOP band only — statements whose subject or anchor is on
// a changed path (what these fixtures use). A statement the scoped mode reached via
// the 1-HOP import ring is invisible to the unscoped modes (no graph, no ring) and
// CAN be capped out; these tests do not claim otherwise.

describe("selectPacketKnowledge — the 0-hop change-relevant band survives the cap in every mode", () => {
  const CAP = 80;
  // 100 statements about the OTHER package, ids sorted BEFORE the relevant ones —
  // enough to fill the cap on their own. This is the fixture shape without which
  // the bug is invisible: under the cap every mode looks monotone.
  const NOISE: KnowledgeStatement[] = Array.from({ length: 100 }, (_, i) =>
    statement(
      `a-noise-${String(i).padStart(3, "0")}`,
      "packages/b/src/other.ts",
      "packages/b/src/other.ts",
    ),
  );
  // 20 statements anchored on the changed file — what the scoped mode would offer.
  const RELEVANT: KnowledgeStatement[] = Array.from({ length: 20 }, (_, i) =>
    statement(
      `z-relevant-${String(i).padStart(3, "0")}`,
      "packages/a/src/changed.ts",
      "packages/a/src/changed.ts",
    ),
  );
  const BIG: KnowledgeSet = { ...SET, statements: [...NOISE, ...RELEVANT] };

  const scoped = selectPacketKnowledge({
    set: BIG,
    snapshot: snapshotOf(),
    changedPaths: CHANGED,
    cap: CAP,
  });

  it("the fixture is big enough for the cap to bite, and the noise sorts first", () => {
    expect(BIG.statements.length).toBeGreaterThan(CAP);
    expect(
      ids(BIG.statements)
        .slice(0, CAP)
        .every((id) => id.startsWith("a-noise")),
    ).toBe(true);
    expect(scoped.mode).toBe("import-graph");
    expect(ids(scoped.statements)).toHaveLength(20);
  });

  it("projected-full keeps the 0-hop band the cap would otherwise evict", () => {
    const full = selectPacketKnowledge({
      set: BIG,
      snapshot: snapshotOf({ omitImports: true }),
      changedPaths: CHANGED,
      cap: CAP,
    });
    expect(full.mode).toBe("projected-full");
    // Control: order these by id alone and the 80-row cap is filled by `a-noise-*`,
    // dropping all 20 relevant rows — the wider mode handing over less.
    for (const id of ids(scoped.statements)) expect(ids(full.statements)).toContain(id);
    expect(full.statements.length).toBeGreaterThanOrEqual(scoped.statements.length);
  });

  it("unprojected keeps the 0-hop band the cap would otherwise evict", () => {
    const raw = selectPacketKnowledge({
      set: BIG,
      snapshot: null,
      changedPaths: CHANGED,
      cap: CAP,
    });
    expect(raw.mode).toBe("unprojected");
    for (const id of ids(scoped.statements)) expect(ids(raw.statements)).toContain(id);
    expect(raw.statements.length).toBeGreaterThanOrEqual(scoped.statements.length);
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
    expect(uncapped.counts.currentSelected).toBeGreaterThan(1);

    const capped = selectPacketKnowledge({
      set: SET,
      snapshot: snapshotOf(),
      changedPaths: CHANGED,
      cap: 1,
    });
    expect(capped.statements).toHaveLength(1);
    // The in-scope total is unchanged by the cap — the cap hides statements, it
    // never makes the packet claim there were fewer to begin with.
    expect(capped.counts.currentSelected).toBe(uncapped.counts.currentSelected);
    expect(capped.counts.truncated).toBe(uncapped.counts.currentSelected - 1);
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
    expect(degraded.coverage).toMatchObject({
      kind: "recorded-unchecked",
      scopeExcludedFiles: 0,
      mechanicallyExcludedFiles: 1,
    });
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
    expect(empty.coverage).toEqual({ kind: "absent" });
  });

  it("distinguishes a legacy unrecorded set from an absent set", () => {
    const legacy = selectPacketKnowledge({
      set: { ...SET, coverage: undefined },
      snapshot: snapshotOf(),
      changedPaths: CHANGED,
    });
    expect(legacy.coverage).toEqual({ kind: "unrecorded" });
    expect(legacy.note).toContain("coverage was not recorded");
  });
});
