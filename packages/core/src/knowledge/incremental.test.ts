import type { KnowledgeSet, KnowledgeStatement, SnapshotSymbol } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import type { LoadedSnapshot } from "../project-context";
import { importShardBytes, symbolShardBytes } from "../project-snapshot";
import { dispositionCarrier, planReverify, routeDelta, structuralChanges } from "./incremental";
import { coalesceFallbackSlices, type PartitionSlice } from "./partition";

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

// ── Signature-diff fixtures (W4) ─────────────────────────────────────────────
//
// A real materialized snapshot in miniature: a `files` inventory, a
// `blobOid → digest` index, and a loader over content-addressed shard bytes built
// by the SAME `symbolShardBytes` production uses — so the hash check inside
// `queryBlobSignature` is genuinely exercised rather than stubbed past.

interface BlobSpec {
  readonly path: string;
  readonly blobOid: string;
  readonly symbols?: readonly SnapshotSymbol[];
  /** The raw import specifiers the blob names — the other half of the signature. */
  readonly imports?: readonly string[];
  readonly generated?: boolean;
  /** Emit no shard for this blob at all (a binary asset, an unindexed blob). */
  readonly noShard?: boolean;
  /** Emit no IMPORTS shard, keeping the symbols shard (a half-indexed manifest). */
  readonly noImportShard?: boolean;
  /** Emit a shard whose bytes do not hash to their digest (a damaged store). */
  readonly damaged?: boolean;
  /** Override the symbol extractor id, to compare two differently-extracted sides. */
  readonly extractor?: string;
  /**
   * Point this blob's manifest entry at ANOTHER blob's symbol shard: a cross-wired
   * index that passes every hash check and answers about the wrong file.
   */
  readonly symbolShardOf?: string;
}

function snapshotOf(blobs: readonly BlobSpec[]): LoadedSnapshot {
  const shards = new Map<string, string>();
  const digestByBlob = new Map<string, string>();
  const importDigestByBlob = new Map<string, string>();
  for (const blob of blobs) {
    if (blob.noShard) continue;
    const built = symbolShardBytes({
      blobOid: blob.symbolShardOf ?? blob.blobOid,
      extractor: blob.extractor ?? "structural-ts-v2",
      generated: blob.generated ?? false,
      symbols: [...(blob.symbols ?? [])],
    });
    digestByBlob.set(blob.blobOid, built.digest);
    shards.set(built.digest, blob.damaged ? `${built.bytes} ` : built.bytes);
    if (blob.noImportShard) continue;
    const imports = importShardBytes({
      blobOid: blob.blobOid,
      extractor: "structural-imports-v1",
      imports: [...(blob.imports ?? [])],
    });
    importDigestByBlob.set(blob.blobOid, imports.digest);
    shards.set(imports.digest, imports.bytes);
  }
  return {
    files: blobs.map((blob) => ({ path: blob.path, blobOid: blob.blobOid })),
    symbolDigestByBlob: digestByBlob,
    importDigestByBlob,
    load: (digest: string) => shards.get(digest),
  } as unknown as LoadedSnapshot;
}

const fn = (name: string, line: number): SnapshotSymbol => ({ name, kind: "function", line });

describe("structuralChanges — the cosmetic/structural signature diff", () => {
  it("a body-only edit is cosmetic: the blob moved, the export signature did not", () => {
    const before = snapshotOf([{ path: "src/a.ts", blobOid: "b1", symbols: [fn("run", 3)] }]);
    const after = snapshotOf([{ path: "src/a.ts", blobOid: "b2", symbols: [fn("run", 3)] }]);
    expect(structuralChanges(["src/a.ts"], after, before)).toEqual([]);
  });

  it("a LINE-ONLY move is cosmetic — the documented decision, not an accident", () => {
    // Every symbol below an inserted line moves. Treating that as structural would
    // make an added import at the top of a file re-run the batch, which is most
    // real diffs.
    const before = snapshotOf([{ path: "src/a.ts", blobOid: "b1", symbols: [fn("run", 3)] }]);
    const after = snapshotOf([{ path: "src/a.ts", blobOid: "b2", symbols: [fn("run", 41)] }]);
    expect(structuralChanges(["src/a.ts"], after, before)).toEqual([]);
  });

  it("an added, removed, renamed or re-kinded export is structural", () => {
    const base: BlobSpec = { path: "src/a.ts", blobOid: "b1", symbols: [fn("run", 3)] };
    const before = snapshotOf([base]);
    const cases: readonly (readonly SnapshotSymbol[])[] = [
      [fn("run", 3), fn("stop", 9)], // added
      [], // removed
      [fn("execute", 3)], // renamed
      [{ name: "run", kind: "class", line: 3 }], // re-kinded
    ];
    for (const symbols of cases) {
      const after = snapshotOf([{ path: "src/a.ts", blobOid: "b2", symbols }]);
      expect(structuralChanges(["src/a.ts"], after, before)).toEqual(["src/a.ts"]);
    }
    // The control: the same fixture with the signature put back is cosmetic, so the
    // four verdicts above are about the signature and not about the changed blobOid.
    const unchanged = snapshotOf([{ path: "src/a.ts", blobOid: "b2", symbols: [fn("run", 3)] }]);
    expect(structuralChanges(["src/a.ts"], unchanged, before)).toEqual([]);
  });

  it("the generated-banner bit moving is structural on its own", () => {
    const before = snapshotOf([{ path: "src/a.ts", blobOid: "b1", symbols: [fn("run", 3)] }]);
    const after = snapshotOf([
      { path: "src/a.ts", blobOid: "b2", symbols: [fn("run", 3)], generated: true },
    ]);
    expect(structuralChanges(["src/a.ts"], after, before)).toEqual(["src/a.ts"]);
  });

  it("a non-TS/JS edit is structural — the extractor's ceiling, refused not guessed", () => {
    // Both shards say `symbols: []`, because that is what the family stores for a
    // file the extractor cannot read. Comparing them would call EVERY markdown and
    // JSON edit cosmetic. The `.ts` case beside it is the control: identical shard
    // contents, opposite verdict, and the only difference is the extension.
    const before = snapshotOf([
      { path: "docs/a.md", blobOid: "m1" },
      { path: "src/z.ts", blobOid: "z1" },
    ]);
    const after = snapshotOf([
      { path: "docs/a.md", blobOid: "m2" },
      { path: "src/z.ts", blobOid: "z2" },
    ]);
    expect(structuralChanges(["docs/a.md", "src/z.ts"], after, before)).toEqual(["docs/a.md"]);
  });

  it("added and deleted paths are structural by definition", () => {
    const before = snapshotOf([{ path: "src/gone.ts", blobOid: "g1", symbols: [] }]);
    const after = snapshotOf([{ path: "src/new.ts", blobOid: "n1", symbols: [] }]);
    expect(structuralChanges(["src/gone.ts", "src/new.ts"], after, before)).toEqual([
      "src/gone.ts",
      "src/new.ts",
    ]);
  });

  it("an unreadable or absent shard on either side falls back to structural", () => {
    const healthy = snapshotOf([{ path: "src/a.ts", blobOid: "b1", symbols: [fn("run", 3)] }]);
    for (const broken of [
      snapshotOf([{ path: "src/a.ts", blobOid: "b2", symbols: [fn("run", 3)], damaged: true }]),
      snapshotOf([{ path: "src/a.ts", blobOid: "b2", noShard: true }]),
    ]) {
      // Broken on the CURRENT side, then on the PRIOR side: neither direction may
      // read "cannot answer" as "unchanged".
      expect(structuralChanges(["src/a.ts"], broken, healthy)).toEqual(["src/a.ts"]);
      expect(structuralChanges(["src/a.ts"], healthy, broken)).toEqual(["src/a.ts"]);
    }
  });

  it("an IMPORT-ONLY edit is structural: same exports, different graph", () => {
    // The export surface is byte-identical on both sides. What moved is what the file
    // imports — which decides its module batch, that batch's cut edges and the
    // neighbour map its worker is fed, none of which the symbol shard can see.
    const before = snapshotOf([
      { path: "src/a.ts", blobOid: "b1", symbols: [fn("run", 3)], imports: ["./one"] },
    ]);
    for (const imports of [
      ["./one", "./two"], // added
      [], // removed
      ["./other"], // re-pointed
    ]) {
      const after = snapshotOf([
        { path: "src/a.ts", blobOid: "b2", symbols: [fn("run", 3)], imports },
      ]);
      expect(structuralChanges(["src/a.ts"], after, before)).toEqual(["src/a.ts"]);
    }
    // The control: the same fixture with the import list put back is cosmetic, so the
    // three verdicts above are about the imports and not about the changed blobOid.
    const unchanged = snapshotOf([
      { path: "src/a.ts", blobOid: "b2", symbols: [fn("run", 3)], imports: ["./one"] },
    ]);
    expect(structuralChanges(["src/a.ts"], unchanged, before)).toEqual([]);
  });

  it("a missing IMPORTS shard cannot answer, so it falls back to structural", () => {
    const healthy = snapshotOf([{ path: "src/a.ts", blobOid: "b1", symbols: [fn("run", 3)] }]);
    const half = snapshotOf([
      { path: "src/a.ts", blobOid: "b2", symbols: [fn("run", 3)], noImportShard: true },
    ]);
    expect(structuralChanges(["src/a.ts"], half, healthy)).toEqual(["src/a.ts"]);
    expect(structuralChanges(["src/a.ts"], healthy, half)).toEqual(["src/a.ts"]);
  });

  it("a CROSS-WIRED shard — valid hash, another blob's structure — is refused", () => {
    // The one wrong answer that looks right: the bytes hash back to the digest the
    // manifest named, so every integrity check passes, and the shard is about a
    // DIFFERENT file. Read as an answer it says "the signature did not move" while
    // describing something else entirely.
    const before = snapshotOf([{ path: "src/a.ts", blobOid: "b1", symbols: [fn("run", 3)] }]);
    const crossWired = snapshotOf([
      // `b2`'s manifest entry points at a shard whose own blobOid is `elsewhere`, and
      // whose symbols happen to match — so only the blobOid check can catch it.
      { path: "src/a.ts", blobOid: "b2", symbols: [fn("run", 3)], symbolShardOf: "elsewhere" },
    ]);
    expect(structuralChanges(["src/a.ts"], crossWired, before)).toEqual(["src/a.ts"]);
  });

  it("two sides produced by DIFFERENT extractors are not comparable, so structural", () => {
    // An older shard's silence is not a newer shard's answer. Identical symbols and
    // imports on both sides; only the extractor identity differs.
    const before = snapshotOf([
      { path: "src/a.ts", blobOid: "b1", symbols: [fn("run", 3)], extractor: "structural-ts-v1" },
    ]);
    const after = snapshotOf([
      { path: "src/a.ts", blobOid: "b2", symbols: [fn("run", 3)], extractor: "structural-ts-v2" },
    ]);
    expect(structuralChanges(["src/a.ts"], after, before)).toEqual(["src/a.ts"]);
  });

  it("an identical blob on both sides is cosmetic; no prior snapshot means all structural", () => {
    const snapshot = snapshotOf([{ path: "src/a.ts", blobOid: "b1", symbols: [fn("run", 3)] }]);
    expect(structuralChanges(["src/a.ts"], snapshot, snapshot)).toEqual([]);
    // The fail-safe: nothing to compare against ⇒ the changed set passes through whole.
    expect(structuralChanges(["src/a.ts"], snapshot, null)).toEqual(["src/a.ts"]);
  });
});

describe("routeDelta", () => {
  it("a slice re-runs only for a STRUCTURAL member; a cosmetic-only slice is not routed", () => {
    // The file-level sharpening, at the seam where it actually takes effect: the same
    // partitions and the same raw changed set, routed once through the whole diff and
    // once through its structural subset.
    const partitions: readonly PartitionSlice[] = [
      {
        id: "mod:src/a.ts#aaaaaaaa",
        files: [
          { path: "src/a.ts", blobOid: "b2" },
          { path: "src/b.ts", blobOid: "c2" },
        ],
        neighbors: [],
      },
      { id: "mod:lib/z.ts#bbbbbbbb", files: [{ path: "lib/z.ts", blobOid: "z2" }], neighbors: [] },
    ];
    const before = snapshotOf([
      { path: "src/a.ts", blobOid: "b1", symbols: [fn("run", 3)] },
      { path: "src/b.ts", blobOid: "c1", symbols: [fn("helper", 1)] },
      { path: "lib/z.ts", blobOid: "z1", symbols: [fn("zed", 1)] },
    ]);
    const after = snapshotOf([
      // A body-only edit, and beside it a real export addition in the SAME slice.
      { path: "src/a.ts", blobOid: "b2", symbols: [fn("run", 3)] },
      { path: "src/b.ts", blobOid: "c2", symbols: [fn("helper", 1), fn("extra", 8)] },
      { path: "lib/z.ts", blobOid: "z2", symbols: [fn("zed", 9)] },
    ]);
    const changed = ["src/a.ts", "src/b.ts", "lib/z.ts"];

    // Partition-level: both slices re-run, because both own a touched file.
    expect(routeDelta(partitions, changed).map((slice) => slice.id)).toHaveLength(2);

    // File-level: the mixed slice runs ONCE for its structural member, and the
    // cosmetic-only slice does not run at all.
    const structural = structuralChanges(changed, after, before);
    expect(structural).toEqual(["src/b.ts"]);
    expect(routeDelta(partitions, structural).map((slice) => slice.id)).toEqual([
      "mod:src/a.ts#aaaaaaaa",
    ]);
  });

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
    // The prior owner is a MODULE batch, so rule 1 (id-family match) cannot fire:
    // `mod:CHANGELOG.md` neither equals nor prefixes `dir:.`. What is under test is
    // rule 2's walk-up bound — delete it and this routes NOTHING, where the old
    // `dir:.` prior made rule 1 answer and left rule 2 unexercised.
    const prior: readonly PartitionSlice[] = [
      {
        id: "mod:CHANGELOG.md#c0ffee00",
        files: [{ path: "CHANGELOG.md", blobOid: "3" }],
        neighbors: [],
      },
    ];
    const routed = routeDelta(current, ["CHANGELOG.md"], prior);
    expect(routed.map((slice) => slice.id)).toEqual(["dir:."]);
  });

  it("routes a deletion under a COALESCED slice's non-head constituent", () => {
    // The real coalescer, not a hand-written slice: thirty constituent families
    // merge into one slice that keeps only the FIRST id. The last family is neither
    // equal to nor a prefix of the head, so a slice carrying only the head answers
    // nothing for a deletion there.
    const merged = coalesceFallbackSlices(
      Array.from({ length: 30 }, (_, index) => {
        const suffix = String(index).padStart(2, "0");
        return {
          id: `dir:docs/d${suffix}`,
          files: [{ path: `docs/d${suffix}/deep/kept.md`, blobOid: suffix }],
          neighbors: [],
        };
      }),
      [],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.families).toHaveLength(30);
    expect(merged[0]?.families).toContain("dir:docs/d29");

    const prior: readonly PartitionSlice[] = [
      {
        id: "dir:docs/d29",
        files: [{ path: "docs/d29/gone.md", blobOid: "gone" }],
        neighbors: [],
      },
    ];
    // Rule 2 is deliberately dead here: nothing survives directly at `docs/d29`,
    // `docs`, or the repo root. Only the retained non-head family can answer.
    expect(routeDelta(merged, ["docs/d29/gone.md"], prior).map((s) => s.id)).toEqual([
      merged[0]?.id,
    ]);
    // The control, in-test: reduce the merged slice to the head family alone — the
    // exact shape before this fix — and the same deletion routes nothing.
    const headOnly = merged.map((slice) => ({ ...slice, families: ["dir:docs/d00"] }));
    expect(routeDelta(headOnly, ["docs/d29/gone.md"], prior)).toEqual([]);
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

  it("DROPS a moved anchor's line span — a cosmetic edit shifts lines and keeps the signature", () => {
    // The exact hazard: an edit this pass calls COSMETIC (same exports) is the edit
    // most likely to move every line in the file. Carrying the span forward leaves the
    // statement pointing at the wrong code under the new blob — rendered verbatim into
    // the verify prompt, and ranked ABOVE an unspanned fresh mint by `betterAnchored`.
    const spanned: KnowledgeStatement = {
      ...statement("s-spanned", ["src/a.ts"], "confirmed"),
      evidence: [
        {
          path: "src/a.ts",
          blobOid: "blob-src/a.ts",
          symbol: "run",
          lines: { startLine: 3, endLine: 9 },
        },
      ],
    };
    const plan = planReverify(
      set([spanned]),
      ["src/a.ts"],
      [{ path: "src/a.ts", blobOid: "blob-a-v2" }],
    );
    const anchor = plan.reverify[0]?.evidence[0];
    expect(anchor?.blobOid).toBe("blob-a-v2");
    expect(anchor?.lines).toBeUndefined();
    // `symbol` is a NAME, not a span: it does not drift with an insertion above it, so
    // the drop is deliberately asymmetric rather than "throw away everything".
    expect(anchor?.symbol).toBe("run");
  });

  it("KEEPS the span on an anchor whose blob did NOT move", () => {
    // The control for the drop above, and the reason it is per-anchor rather than
    // per-statement: a cross-cutting statement re-verifies because ONE cited path
    // changed, and the anchors into files nobody touched are still exact. Dropping
    // those spans too would degrade evidence for no reason at all.
    const crossCutting: KnowledgeStatement = {
      ...statement("s-cross", ["src/a.ts", "lib/b.ts"]),
      evidence: [
        { path: "src/a.ts", blobOid: "blob-src/a.ts", lines: { startLine: 1, endLine: 2 } },
        { path: "lib/b.ts", blobOid: "blob-lib/b.ts", lines: { startLine: 40, endLine: 44 } },
      ],
    };
    const plan = planReverify(
      set([crossCutting]),
      ["src/a.ts"],
      [
        { path: "src/a.ts", blobOid: "blob-a-v2" },
        { path: "lib/b.ts", blobOid: "blob-lib/b.ts" },
      ],
    );
    const [moved, still] = plan.reverify[0]?.evidence ?? [];
    expect(moved?.lines).toBeUndefined();
    expect(still?.lines).toEqual({ startLine: 40, endLine: 44 });
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
