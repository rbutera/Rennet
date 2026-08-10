/**
 * Base + overlay composition for a NON-DEFAULT base (#143, design §3) — the pure,
 * MODEL-FREE, BYTE-REPRODUCIBLE half.
 *
 * The default-branch ProjectSnapshot is the BASE. A review whose base is a
 * non-default branch reads a MERGED view rather than a full independent snapshot:
 * the base map plus a per-non-default-base OVERLAY that records only what differs
 * from the base (overlay-wins per shard key, with tombstones for symbol shards the
 * non-default base dropped). The load-bearing property mirrors the incremental
 * snapshot's: `mergeOverlay(base, composeOverlay(base, target))` reconstructs
 * `target` byte-for-byte, so a merged read is byte-equivalent to a clean full build
 * at the non-default-base OID while storing only the delta.
 *
 * All IO (building the target snapshot at the non-default OID, storing/reading the
 * overlay) lives in `@rennet/adapters`; this module is a pure function of two
 * manifests and is exercised by a pure test that never touches git or the disk.
 */

import { canonicalize, sha256Hex } from "@rennet/protocol";
import type {
  ProjectSnapshotManifest,
  ShardRef,
  SnapshotOverlay,
  StructuralShardSlot,
} from "@rennet/types";
import { PROJECT_SNAPSHOT_SCHEMA_VERSION, SNAPSHOT_OVERLAY_SCHEMA_VERSION } from "@rennet/types";

const STRUCTURAL_SLOTS: readonly StructuralShardSlot[] = [
  "files",
  "scopes",
  "edges",
  "entryPoints",
  "tests",
  "ownership",
  "conventions",
];

function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The composite `(base, overlay)` id a non-default-base review pins to. A digest
 * over BOTH the base map fingerprint and the target (merged) fingerprint, so it
 * changes if either side moves — which is exactly what makes the `(defaultOid,
 * nonDefaultBaseOid)` freshness checkable from the pin alone.
 */
export function compositeSnapshotId(baseFingerprint: string, targetFingerprint: string): string {
  return sha256Hex(canonicalize({ base: baseFingerprint, target: targetFingerprint }));
}

/**
 * Compute the overlay = the `base → target` delta. `target` is the snapshot at the
 * non-default base OID (built incrementally from the base, so its unchanged shards
 * are byte-identical to the base's). The delta is:
 *  - structural: every slot whose digest differs from the base (overlay-wins);
 *  - symbols: every `(blobOid, digest)` that is new or changed vs the base
 *    (overlay-wins), plus tombstones for base blobOids absent from the target.
 */
export function composeOverlay(
  base: ProjectSnapshotManifest,
  target: ProjectSnapshotManifest,
): SnapshotOverlay {
  const structuralDelta: Partial<Record<StructuralShardSlot, ShardRef>> = {};
  for (const slot of STRUCTURAL_SLOTS) {
    const b = base.shards[slot];
    const t = target.shards[slot];
    // A slot is always present in every manifest, so there is no structural
    // tombstone — a slot either matches the base (inherit) or differs (overlay).
    if (!b || b.digest !== t.digest) structuralDelta[slot] = t;
  }

  const baseByBlob = new Map(base.symbols.map(([blob, digest]) => [blob, digest] as const));
  const targetBlobs = new Set(target.symbols.map(([blob]) => blob));

  const symbolUpserts: [string, string][] = [];
  for (const [blob, digest] of target.symbols) {
    // new blob, or same blob with a different shard digest ⇒ overlay-wins.
    if (baseByBlob.get(blob) !== digest) symbolUpserts.push([blob, digest]);
  }
  symbolUpserts.sort((l, r) => byString(l[0], r[0]));

  const symbolTombstones = [...baseByBlob.keys()].filter((blob) => !targetBlobs.has(blob)).sort();

  return {
    schemaVersion: SNAPSHOT_OVERLAY_SCHEMA_VERSION,
    repoKey: target.repoKey,
    baseFingerprint: base.fingerprint,
    baseDefaultOid: base.baseOid,
    targetBaseRef: target.baseRef,
    targetBaseRefResolution: target.baseRefResolution,
    targetBaseOid: target.baseOid,
    targetFingerprint: target.fingerprint,
    compositeId: compositeSnapshotId(base.fingerprint, target.fingerprint),
    structuralDelta,
    symbolUpserts,
    symbolTombstones,
  };
}

/**
 * Reconstruct the merged (target-equivalent) manifest by applying an overlay to a
 * base manifest. Overlay-wins per structural slot; symbol tombstones are removed
 * and upserts applied over the base's symbol set, then re-sorted by blobOid. The
 * result is byte-identical to the target manifest `composeOverlay` was derived
 * from (the load-bearing invariant), so it self-verifies under
 * `verifySnapshotIntegrity` and pins to the target's own fingerprint.
 */
export function mergeOverlay(
  base: ProjectSnapshotManifest,
  overlay: SnapshotOverlay,
): ProjectSnapshotManifest {
  const shards = { ...base.shards, ...overlay.structuralDelta } as Record<
    StructuralShardSlot,
    ShardRef
  >;

  const byBlob = new Map(base.symbols.map(([blob, digest]) => [blob, digest] as const));
  for (const blob of overlay.symbolTombstones) byBlob.delete(blob);
  for (const [blob, digest] of overlay.symbolUpserts) byBlob.set(blob, digest);
  const symbols = [...byBlob.entries()].sort((l, r) => byString(l[0], r[0]));

  return {
    schemaVersion: PROJECT_SNAPSHOT_SCHEMA_VERSION,
    repoKey: overlay.repoKey,
    baseRef: overlay.targetBaseRef,
    baseRefResolution: overlay.targetBaseRefResolution,
    baseOid: overlay.targetBaseOid,
    fingerprint: overlay.targetFingerprint,
    shards,
    symbols,
  };
}

/**
 * Whether a stored overlay is fresh for the current base map. Freshness is content
 * equality of the `(defaultOid, nonDefaultBaseOid)` pair, never age: the overlay's
 * `baseFingerprint` must still equal the base map's fingerprint (which advances
 * with the default OID) and the schema version must match. A stale overlay is
 * re-derived against the new base rather than served.
 */
export function isOverlayFresh(overlay: SnapshotOverlay, base: ProjectSnapshotManifest): boolean {
  return (
    overlay.schemaVersion === SNAPSHOT_OVERLAY_SCHEMA_VERSION &&
    overlay.baseFingerprint === base.fingerprint
  );
}
