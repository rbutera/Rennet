import {
  composeOverlay,
  isOverlayFresh,
  type LoadedSnapshot,
  materializeSnapshot,
  mergeOverlay,
  type SnapshotGateFailure,
  verifySnapshotIntegrity,
} from "@rennet/core";
import type { SnapshotOverlay, StructuralShardSlot } from "@rennet/protocol";
import { execaGit, type GitExec } from "./git-range-diff";
import { ProjectSnapshotGenerator } from "./project-snapshot-generator";
import type { ProjectSnapshotStore } from "./project-snapshot-store";
import {
  DEFAULT_OVERLAY_MAX_ENTRIES,
  type OverlayReapResult,
  type SnapshotOverlayStore,
} from "./snapshot-overlay-store";

const STRUCTURAL_SLOTS: readonly StructuralShardSlot[] = [
  "files",
  "scopes",
  "edges",
  "entryPoints",
  "tests",
  "ownership",
  "conventions",
];

/**
 * The base+overlay DERIVATION engine (#143, design §3), the git-capable half.
 *
 * The default-branch map is the BASE. When a review targets a NON-DEFAULT base,
 * this derives the overlay = the deterministic `defaultOid..nonDefaultBaseOid`
 * delta, by building the snapshot at the non-default OID with the wave-1
 * incremental machinery (reusing the base's symbol shards for unchanged blobs) and
 * storing ONLY the shard bytes that changed. It NEVER advances the base map — the
 * target build runs with no store, so the base store is untouched.
 *
 * Derivation is off the review's critical path: the SYNC {@link SnapshotOverlayReader}
 * reads what is on disk and fails closed if the overlay is missing or stale, exactly
 * as the base-map gate does. Re-derivation happens here (on review open, or after a
 * baseline advance stales the overlay), never inside a read.
 */

/** The outcome of ensuring a fresh overlay exists for a non-default base. */
export type EnsureOverlayResult =
  | { readonly ok: true; readonly overlay: SnapshotOverlay; readonly derived: boolean }
  | { readonly ok: false; readonly reason: "no-base-map" };

export class SnapshotOverlayGenerator {
  constructor(
    private readonly deps: {
      readonly store: ProjectSnapshotStore;
      readonly overlayStore: SnapshotOverlayStore;
      readonly git?: GitExec;
      /** LRU bound on retained overlays (design §8.4). */
      readonly maxEntries?: number;
    },
  ) {}

  private get git(): GitExec {
    return this.deps.git ?? execaGit;
  }

  /**
   * Ensure a fresh overlay exists for `nonDefaultBaseOid`, deriving it if absent or
   * stale (the base map advanced). Reuses a fresh overlay verbatim. After a derive,
   * reaps per the retention policy so the overlay store stays bounded.
   */
  async ensureOverlay(
    repoRoot: string,
    repoKey: string,
    nonDefaultBaseOid: string,
  ): Promise<EnsureOverlayResult> {
    const base = this.deps.store.loadManifest(repoKey);
    if (!base) return { ok: false, reason: "no-base-map" };

    const existing = this.deps.overlayStore.read(repoKey, nonDefaultBaseOid);
    if (existing && isOverlayFresh(existing, base)) {
      this.deps.overlayStore.touch(repoKey, nonDefaultBaseOid);
      return { ok: true, overlay: existing, derived: false };
    }

    // Build the target snapshot at the non-default OID WITHOUT a store (so the base
    // map is never advanced), reusing the base's symbol shards for unchanged blobs.
    const previousSymbols = this.deps.store.loadSymbolShards(base);
    const target = await new ProjectSnapshotGenerator({ git: this.git }).generate(repoRoot, {
      explicitBaseRef: nonDefaultBaseOid,
      previousSymbols,
    });

    const overlay = composeOverlay(base, target.manifest);

    // Delta shard bytes = only the digests the delta references (structural slots
    // that changed + upserted symbol shards). These differ from the base by
    // construction, so they are genuinely new bytes the base store does not hold.
    const deltaBytes = new Map<string, string>();
    for (const slot of STRUCTURAL_SLOTS) {
      const ref = overlay.structuralDelta[slot];
      if (!ref) continue;
      const bytes = target.built.shards.get(ref.digest);
      if (bytes !== undefined) deltaBytes.set(ref.digest, bytes);
    }
    for (const [, digest] of overlay.symbolUpserts) {
      const bytes = target.built.shards.get(digest);
      if (bytes !== undefined) deltaBytes.set(digest, bytes);
    }
    // Reference-shard upserts are genuinely new bytes vs the base too (#200), and so
    // are import-shard upserts.
    for (const [, digest] of [...overlay.referenceUpserts, ...overlay.importUpserts]) {
      const bytes = target.built.shards.get(digest);
      if (bytes !== undefined) deltaBytes.set(digest, bytes);
    }

    this.deps.overlayStore.write(overlay, deltaBytes);
    await this.reapOverlays(repoRoot, repoKey);
    return { ok: true, overlay, derived: true };
  }

  /**
   * Reap the repo's overlays per the retention policy: drop any whose target base
   * OID is no longer reachable in git, then LRU-evict beyond `maxEntries`.
   * Reachability is probed once (async git) and passed to the sync store reaper.
   */
  async reapOverlays(repoRoot: string, repoKey: string): Promise<OverlayReapResult> {
    const present = this.deps.overlayStore.list(repoKey);
    const reachable = new Set<string>();
    for (const oid of present) {
      if (await this.isReachable(repoRoot, oid)) reachable.add(oid);
    }
    return this.deps.overlayStore.reap(repoKey, {
      maxEntries: this.deps.maxEntries ?? DEFAULT_OVERLAY_MAX_ENTRIES,
      isReachable: (oid) => reachable.has(oid),
    });
  }

  /** Whether a commit OID still exists in the repo (the drop-when-unreachable probe). */
  private async isReachable(repoRoot: string, oid: string): Promise<boolean> {
    try {
      await this.git(repoRoot, ["cat-file", "-e", `${oid}^{commit}`], { reject: true });
      return true;
    } catch {
      return false;
    }
  }
}

/** The gated merged snapshot for a non-default base, or a typed gate failure. */
export type MergedSnapshotResult =
  | {
      readonly ok: true;
      readonly snapshot: LoadedSnapshot;
      /** The composite `(base, overlay)` id the review pins to. */
      readonly projectSnapshotId: string;
      readonly baseOid: string;
    }
  | { readonly ok: false; readonly failure: SnapshotGateFailure };

/**
 * A source of merged (base + overlay) snapshots for a non-default base. Injected
 * into consumers (e.g. the novelty ledger) so they classify against the effective
 * merged baseline without depending on the git-capable derivation engine.
 */
export interface MergedSnapshotSource {
  resolveMerged(repoKey: string, nonDefaultBaseOid: string): MergedSnapshotResult;
}

/**
 * The SYNC, fail-closed merged-snapshot READ gate — the base+overlay analogue of
 * {@link ProjectContextReader.loadFresh}. It reads the base map and a warmed
 * overlay off disk, checks the overlay is fresh against the current base, merges
 * them, and verifies integrity + materializes over a loader that resolves a shard
 * from the overlay dir first and the base store second. No git, no build: a missing
 * or stale overlay fails closed (the derivation engine warms it), never a served
 * mismatched baseline (Rule 75, the vital "never consume stale context" circuit).
 */
export class SnapshotOverlayReader implements MergedSnapshotSource {
  constructor(
    private readonly deps: {
      readonly store: ProjectSnapshotStore;
      readonly overlayStore: SnapshotOverlayStore;
    },
  ) {}

  resolveMerged(repoKey: string, nonDefaultBaseOid: string): MergedSnapshotResult {
    const base = this.deps.store.loadManifest(repoKey);
    if (!base) return { ok: false, failure: { reason: "absent" } };

    const overlay = this.deps.overlayStore.read(repoKey, nonDefaultBaseOid);
    // A missing or stale overlay is refused as "stale" — a base map exists but the
    // merged view for this non-default base is not warmed/current. The derivation
    // engine re-warms it; a read never builds.
    if (!overlay || !isOverlayFresh(overlay, base)) {
      return {
        ok: false,
        failure: {
          reason: "stale",
          storedBaseOid: base.baseOid,
          requestedBaseOid: nonDefaultBaseOid,
        },
      };
    }

    const merged = mergeOverlay(base, overlay);
    const load = (digest: string): string | undefined =>
      this.deps.overlayStore.loadShard(repoKey, nonDefaultBaseOid, digest) ??
      this.deps.store.loadShard(repoKey, digest);

    try {
      const integrity = verifySnapshotIntegrity(merged, load);
      if (!integrity.ok) {
        return {
          ok: false,
          failure: {
            reason: "corrupt",
            missing: integrity.missing,
            mismatched: integrity.mismatched,
          },
        };
      }
      const materialized = materializeSnapshot(merged, load);
      if (!materialized.ok) {
        return {
          ok: false,
          failure: { reason: "corrupt", missing: materialized.slots, mismatched: [] },
        };
      }
      return {
        ok: true,
        snapshot: materialized.snapshot,
        projectSnapshotId: overlay.compositeId,
        baseOid: nonDefaultBaseOid,
      };
    } catch {
      return { ok: false, failure: { reason: "corrupt", missing: [], mismatched: [] } };
    }
  }
}
