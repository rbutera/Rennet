import type { KnowledgeSet, KnowledgeStatement } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { dispositionCarrier, planReverify, routeDelta } from "./incremental";
import type { PartitionSlice } from "./partition";

const PARTITIONS: readonly PartitionSlice[] = [
  { id: "src", files: [{ path: "src/a.ts", blobOid: "blob-a" }], neighbors: [] },
  { id: "lib", files: [{ path: "lib/b.ts", blobOid: "blob-b" }], neighbors: [] },
  { id: "dir:docs", files: [{ path: "docs/c.md", blobOid: "blob-c" }], neighbors: [] },
];

function statement(
  id: string,
  paths: readonly string[],
  status: KnowledgeStatement["status"] = "hypothesis",
): KnowledgeStatement {
  return {
    id,
    subject: id,
    aspect: "purpose",
    claim: `claim ${id}`,
    evidence: paths.map((path) => ({ path, blobOid: `blob-${path}` })),
    confidence: "high",
    status,
    provenance: { generator: "knowledge-swarm@1", model: null, apiKeySource: null },
    learnedAgainst: { baseOid: "a".repeat(40), snapshotFingerprint: "fp-1" },
  };
}

function set(statements: readonly KnowledgeStatement[]): KnowledgeSet {
  return {
    schemaVersion: 1,
    repoKey: "repo",
    baseOid: "a".repeat(40),
    snapshotFingerprint: "fp-1",
    generator: "knowledge-swarm@1",
    statements,
  };
}

describe("routeDelta", () => {
  it("one changed file re-runs exactly its owning partition", () => {
    const routed = routeDelta(PARTITIONS, ["lib/b.ts"]);
    expect(routed.map((slice) => slice.id)).toEqual(["lib"]);
  });

  it("no changed paths routes nothing; an orphan with no prior owner routes nothing", () => {
    expect(routeDelta(PARTITIONS, [])).toEqual([]);
    expect(routeDelta(PARTITIONS, ["deleted/gone.ts"])).toEqual([]);
  });

  it("a deleted path routes its PRIOR owner's current slice family", () => {
    const prior: readonly PartitionSlice[] = [
      {
        id: "lib",
        files: [
          { path: "lib/b.ts", blobOid: "blob-b" },
          { path: "lib/gone.ts", blobOid: "blob-gone" },
        ],
        neighbors: [],
      },
    ];
    // lib/gone.ts no longer exists in any current slice — its prior owner id
    // matches the current "lib" slice, which re-runs.
    const routed = routeDelta(PARTITIONS, ["lib/gone.ts"], prior);
    expect(routed.map((slice) => slice.id)).toEqual(["lib"]);
  });

  it("split-boundary drift: a prior parent id routes its current sub-slices", () => {
    const current: readonly PartitionSlice[] = [
      { id: "lib/x", files: [{ path: "lib/x/a.ts", blobOid: "1" }], neighbors: [] },
      { id: "src", files: [{ path: "src/a.ts", blobOid: "2" }], neighbors: [] },
    ];
    const prior: readonly PartitionSlice[] = [
      { id: "lib", files: [{ path: "lib/x/gone.ts", blobOid: "3" }], neighbors: [] },
    ];
    const routed = routeDelta(current, ["lib/x/gone.ts"], prior);
    expect(routed.map((slice) => slice.id)).toEqual(["lib/x"]);
  });

  it("a path whose prior slice family vanished routes nothing (planReverify still covers it)", () => {
    const prior: readonly PartitionSlice[] = [
      { id: "legacy", files: [{ path: "legacy/gone.ts", blobOid: "1" }], neighbors: [] },
    ];
    expect(routeDelta(PARTITIONS, ["legacy/gone.ts"], prior)).toEqual([]);
  });

  // ── Cross-tier routing: the id families do not overlap between tiers, so the
  // nearest-surviving-directory rule is the only thing that can route these.

  it("routes across tiers: a hierarchical PRIOR owner reaches the current mod: batch", () => {
    const current: readonly PartitionSlice[] = [
      {
        id: "mod:packages/a/src/one.ts#deadbeef",
        files: [
          { path: "packages/a/src/one.ts", blobOid: "1" },
          { path: "packages/a/src/two.ts", blobOid: "2" },
        ],
        neighbors: [],
      },
      { id: "dir:docs", files: [{ path: "docs/guide.md", blobOid: "3" }], neighbors: [] },
    ];
    const prior: readonly PartitionSlice[] = [
      { id: "@x/a", files: [{ path: "packages/a/src/gone.ts", blobOid: "4" }], neighbors: [] },
    ];
    // No `mod:` family can ever match the `@x/a` family — only the surviving
    // sibling directory `packages/a/src` reaches the batch that holds it.
    const routed = routeDelta(current, ["packages/a/src/gone.ts"], prior);
    expect(routed.map((slice) => slice.id)).toEqual(["mod:packages/a/src/one.ts#deadbeef"]);
  });

  it("routes across tiers the other way: a mod: PRIOR owner reaches the current fallback slice", () => {
    const current: readonly PartitionSlice[] = [
      { id: "@x/a", files: [{ path: "packages/a/src/one.ts", blobOid: "1" }], neighbors: [] },
      { id: "dir:docs", files: [{ path: "docs/guide.md", blobOid: "2" }], neighbors: [] },
    ];
    const prior: readonly PartitionSlice[] = [
      {
        id: "mod:packages/a/src/gone.ts#c0ffee00",
        files: [{ path: "packages/a/src/gone.ts", blobOid: "3" }],
        neighbors: [],
      },
    ];
    const routed = routeDelta(current, ["packages/a/src/gone.ts"], prior);
    expect(routed.map((slice) => slice.id)).toEqual(["@x/a"]);
  });

  it("walks UP to the nearest surviving directory when the whole directory is gone", () => {
    const current: readonly PartitionSlice[] = [
      {
        id: "mod:packages/a/src/one.ts#deadbeef",
        files: [{ path: "packages/a/src/one.ts", blobOid: "1" }],
        neighbors: [],
      },
      { id: "dir:docs", files: [{ path: "docs/guide.md", blobOid: "2" }], neighbors: [] },
    ];
    const prior: readonly PartitionSlice[] = [
      {
        id: "mod:packages/a/src/legacy/x.ts#c0ffee00",
        files: [{ path: "packages/a/src/legacy/x.ts", blobOid: "3" }],
        neighbors: [],
      },
    ];
    // `packages/a/src/legacy` holds nothing now; `packages/a/src` does.
    const routed = routeDelta(current, ["packages/a/src/legacy/x.ts"], prior);
    expect(routed.map((slice) => slice.id)).toEqual(["mod:packages/a/src/one.ts#deadbeef"]);
  });

  it("a deleted ROOT-level file routes the root-level slices only, never the whole repo", () => {
    const current: readonly PartitionSlice[] = [
      { id: "dir:.", files: [{ path: "README.md", blobOid: "1" }], neighbors: [] },
      {
        id: "mod:packages/a/src/one.ts#deadbeef",
        files: [{ path: "packages/a/src/one.ts", blobOid: "2" }],
        neighbors: [],
      },
    ];
    const prior: readonly PartitionSlice[] = [
      { id: "dir:.", files: [{ path: "CHANGELOG.md", blobOid: "3" }], neighbors: [] },
    ];
    const routed = routeDelta(current, ["CHANGELOG.md"], prior);
    expect(routed.map((slice) => slice.id)).toEqual(["dir:."]);
  });
});

describe("planReverify", () => {
  it("splits evidence-touched from carried, carry byte-identical", () => {
    const touched = statement("s-touched", ["src/a.ts"]);
    const untouched = statement("s-untouched", ["lib/b.ts"]);
    const plan = planReverify(set([touched, untouched]), ["src/a.ts"]);
    expect(plan.reverify).toEqual([touched]);
    expect(plan.carried).toHaveLength(1);
    // Carried verbatim: the SAME object, not a rebuilt copy.
    expect(plan.carried[0]).toBe(untouched);
  });

  it("cross-cutting sensitivity: multi-slice evidence re-verifies on ANY cited path", () => {
    const crossCutting = statement("s-cross", ["src/a.ts", "docs/c.md"]);
    // docs/c.md changed — src's partition is not re-running, the statement still re-verifies.
    const plan = planReverify(set([crossCutting]), ["docs/c.md"]);
    expect(plan.reverify).toEqual([crossCutting]);
    expect(plan.carried).toEqual([]);
    expect(plan.invalidated).toEqual([]);
  });

  it("re-anchors reverify entries against the new inventory: fresh blobOid, fresh id, back to hypothesis", () => {
    const confirmed = statement("s-old", ["src/a.ts"], "confirmed");
    const plan = planReverify(
      set([confirmed]),
      ["src/a.ts"],
      [{ path: "src/a.ts", blobOid: "blob-a-v2" }],
    );
    expect(plan.invalidated).toEqual([]);
    const reanchored = plan.reverify[0];
    expect(reanchored?.evidence[0]?.blobOid).toBe("blob-a-v2");
    // Evidence moved ⇒ new identity ⇒ the prior confirmation does not carry.
    expect(reanchored?.id).not.toBe("s-old");
    expect(reanchored?.status).toBe("hypothesis");
  });

  it("a statement whose evidence is entirely deleted is invalidated, never carried as completed", () => {
    const confirmed = statement("s-dead", ["src/a.ts"], "confirmed");
    const survivor = statement("s-live", ["lib/b.ts"]);
    const plan = planReverify(
      set([confirmed, survivor]),
      ["src/a.ts"],
      [{ path: "lib/b.ts", blobOid: "blob-lib/b.ts" }],
    );
    expect(plan.invalidated).toEqual([confirmed]);
    expect(plan.reverify).toEqual([]);
    expect(plan.carried).toEqual([survivor]);
  });
});

describe("dispositionCarrier", () => {
  it("keeps a prior confirmed/rejected status for a re-minted same-id claim", () => {
    const prior = set([statement("s-1", ["src/a.ts"], "confirmed")]);
    const carry = dispositionCarrier(prior);
    const reminted = statement("s-1", ["src/a.ts"]);
    expect(carry(reminted).status).toBe("confirmed");
    // A new id is a genuinely new claim — stays a hypothesis.
    expect(carry(statement("s-2", ["src/a.ts"])).status).toBe("hypothesis");
  });

  it("never overwrites a verdict minted in the CURRENT pass", () => {
    const prior = set([statement("s-1", ["src/a.ts"], "rejected")]);
    const carry = dispositionCarrier(prior);
    // The verify seat just confirmed it this pass — the stale rejection loses.
    const fresh = statement("s-1", ["src/a.ts"], "confirmed");
    expect(carry(fresh).status).toBe("confirmed");
  });
});
