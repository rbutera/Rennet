import type {
  BaseRefResolution,
  ProjectSnapshotManifest,
  ShardRef,
  StructuralShardSlot,
} from "@rennet/protocol";
import {
  canonicalize,
  PROJECT_SNAPSHOT_SCHEMA_VERSION,
  SNAPSHOT_OVERLAY_SCHEMA_VERSION,
} from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { computeFingerprint } from "./project-snapshot";
import {
  composeOverlay,
  compositeSnapshotId,
  isOverlayFresh,
  mergeOverlay,
} from "./snapshot-overlay";

const SLOTS: readonly StructuralShardSlot[] = [
  "files",
  "scopes",
  "edges",
  "entryPoints",
  "tests",
  "ownership",
  "conventions",
];

/** Build a manifest whose fingerprint is genuinely computed, so it self-verifies. */
function manifest(opts: {
  baseRef: string;
  baseOid: string;
  resolution?: BaseRefResolution;
  structural: Partial<Record<StructuralShardSlot, string>>;
  symbols: [string, string][];
  references?: [string, string][];
  imports?: [string, string][];
  repoKey?: string;
}): ProjectSnapshotManifest {
  const repoKey = opts.repoKey ?? "-tmp-repo";
  const shards = {} as Record<StructuralShardSlot, ShardRef>;
  for (const slot of SLOTS) {
    shards[slot] = { digest: opts.structural[slot] ?? `d-${slot}`, entries: 1 };
  }
  const resolution = opts.resolution ?? "symbolic-head";
  const symbols = [...opts.symbols].sort((l, r) => (l[0] < r[0] ? -1 : 1));
  const references = [...(opts.references ?? [])].sort((l, r) => (l[0] < r[0] ? -1 : 1));
  const imports = [...(opts.imports ?? [])].sort((l, r) => (l[0] < r[0] ? -1 : 1));
  const unfingerprinted = {
    schemaVersion: PROJECT_SNAPSHOT_SCHEMA_VERSION,
    repoKey,
    baseRef: opts.baseRef,
    baseRefResolution: resolution,
    baseOid: opts.baseOid,
    shards,
    symbols,
    references,
    imports,
  };
  return { ...unfingerprinted, fingerprint: computeFingerprint(unfingerprinted) };
}

describe("composeOverlay / mergeOverlay — the byte-equivalence invariant", () => {
  it("mergeOverlay(base, composeOverlay(base, target)) reconstructs the target exactly", () => {
    const base = manifest({
      baseRef: "main",
      baseOid: "aaaa",
      structural: { files: "f1", scopes: "s1", edges: "e1" },
      symbols: [
        ["blobA", "symA"],
        ["blobB", "symB"],
        ["blobKeep", "symKeep"],
      ],
    });
    const target = manifest({
      baseRef: "feature-x",
      baseOid: "bbbb",
      resolution: "explicit-setting",
      // files+scopes changed; edges same as base; a symbol changed, one added, one dropped.
      structural: { files: "f2", scopes: "s2", edges: "e1" },
      symbols: [
        ["blobA", "symA2"], // changed
        ["blobKeep", "symKeep"], // unchanged
        ["blobNew", "symNew"], // added
        // blobB dropped ⇒ tombstone
      ],
    });

    const overlay = composeOverlay(base, target);

    // The delta captured exactly what differs — edges are inherited, not in the delta.
    expect(Object.keys(overlay.structuralDelta).sort()).toEqual(["files", "scopes"]);
    expect(overlay.symbolUpserts).toEqual([
      ["blobA", "symA2"],
      ["blobNew", "symNew"],
    ]);
    expect(overlay.symbolTombstones).toEqual(["blobB"]);

    const merged = mergeOverlay(base, overlay);
    // BYTE-identical to the target — the load-bearing property.
    expect(canonicalize(merged)).toBe(canonicalize(target));
    expect(merged.fingerprint).toBe(target.fingerprint);
  });

  it("a symbol dropped on the target is a tombstone and the merged view omits it", () => {
    const base = manifest({
      baseRef: "main",
      baseOid: "aaaa",
      structural: {},
      symbols: [
        ["blobGone", "symGone"],
        ["blobStay", "symStay"],
      ],
    });
    const target = manifest({
      baseRef: "topic",
      baseOid: "cccc",
      structural: {},
      symbols: [["blobStay", "symStay"]],
    });
    const overlay = composeOverlay(base, target);
    expect(overlay.symbolTombstones).toEqual(["blobGone"]);
    const merged = mergeOverlay(base, overlay);
    expect(merged.symbols.map(([b]) => b)).toEqual(["blobStay"]);
    expect(canonicalize(merged)).toBe(canonicalize(target));
  });

  it("an identical target yields an empty structural delta and no symbol changes", () => {
    const base = manifest({
      baseRef: "main",
      baseOid: "aaaa",
      structural: {},
      symbols: [["blobA", "symA"]],
    });
    // Same tree content, but pinned to a different ref/oid (e.g. a fast-forwarded branch).
    const target = manifest({
      baseRef: "release",
      baseOid: "dddd",
      structural: {},
      symbols: [["blobA", "symA"]],
    });
    const overlay = composeOverlay(base, target);
    expect(Object.keys(overlay.structuralDelta)).toHaveLength(0);
    expect(overlay.symbolUpserts).toHaveLength(0);
    expect(overlay.symbolTombstones).toHaveLength(0);
    expect(canonicalize(mergeOverlay(base, overlay))).toBe(canonicalize(target));
  });
});

describe("compositeSnapshotId / isOverlayFresh", () => {
  it("the composite id changes if EITHER the base or the target fingerprint moves", () => {
    const a = compositeSnapshotId("base1", "target1");
    expect(compositeSnapshotId("base1", "target1")).toBe(a); // deterministic
    expect(compositeSnapshotId("base2", "target1")).not.toBe(a); // base moved
    expect(compositeSnapshotId("base1", "target2")).not.toBe(a); // target moved
  });

  it("an overlay is stale once the base map fingerprint advances", () => {
    const base = manifest({ baseRef: "main", baseOid: "aaaa", structural: {}, symbols: [] });
    const target = manifest({ baseRef: "topic", baseOid: "bbbb", structural: {}, symbols: [] });
    const overlay = composeOverlay(base, target);
    expect(isOverlayFresh(overlay, base)).toBe(true);

    const advancedBase = manifest({
      baseRef: "main",
      baseOid: "aaaa2",
      structural: { files: "f-new" },
      symbols: [],
    });
    expect(advancedBase.fingerprint).not.toBe(base.fingerprint);
    expect(isOverlayFresh(overlay, advancedBase)).toBe(false);
  });

  it("a schema-version mismatch is stale", () => {
    const base = manifest({ baseRef: "main", baseOid: "aaaa", structural: {}, symbols: [] });
    const target = manifest({ baseRef: "topic", baseOid: "bbbb", structural: {}, symbols: [] });
    const overlay = {
      ...composeOverlay(base, target),
      schemaVersion: SNAPSHOT_OVERLAY_SCHEMA_VERSION + 1,
    };
    expect(isOverlayFresh(overlay, base)).toBe(false);
  });
});
