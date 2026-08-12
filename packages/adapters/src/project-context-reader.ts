import {
  isSnapshotFresh,
  type LoadedSnapshot,
  materializeSnapshot,
  type ProjectFileOverviewResult,
  type ProjectFileResult,
  type ProjectMapResult,
  type ProjectMapScope,
  type ProjectReferenceResult,
  type ProjectSymbolDefinitionResult,
  queryFileContext,
  queryFileOverview,
  queryProjectMap,
  queryReferences,
  querySymbolDefinition,
  type ReferenceLookup,
  type SnapshotGateFailure,
  type SymbolLookup,
  verifySnapshotIntegrity,
} from "@rennet/core";
import type { ProjectSnapshotStore } from "./project-snapshot-store";
import type { MergedSnapshotSource } from "./snapshot-overlay-generator";

// The gate-failure taxonomy and the two gated result unions are CANONICAL in
// `@rennet/core` (alongside `ProjectMap` / `FileContextResult`) so the pure
// `canvasOps@2` context tools can speak them without a core → adapters edge.
// Re-exported here for stability: existing importers (and the adapters barrel)
// keep resolving them from this module.
export type {
  ProjectFileOverviewResult,
  ProjectFileResult,
  ProjectMapResult,
  ProjectReferenceResult,
  ProjectSymbolDefinitionResult,
  SnapshotGateFailure,
} from "@rennet/core";

/**
 * The composed, fail-closed ProjectSnapshot READ gate (#14, Part 3) — the single
 * call the `context.map` / `context.file` consumers pass a request through so a
 * STALE or CORRUPT snapshot can never enter it. This is exactly the `loadCurrent`
 * gate `ProjectSnapshotStore` left as a deferred NOTE ("wire the gate when the
 * first consumer lands so it is covered by a real caller") — the context reader
 * IS that first consumer.
 *
 * The gate composes the pieces the foundation built and individually tested:
 *   1. `store.loadManifestAt`      — the manifest for the REQUESTED base OID (#246),
 *                                    so a pinned read survives a background advance.
 *   2. `isSnapshotFresh`           — freshness is content equality at the
 *                                    REQUESTED base OID, never age (R30). A
 *                                    snapshot built at any other OID is stale.
 *   3. `verifySnapshotIntegrity`   — every referenced shard is present AND hashes
 *                                    back to its digest AND the manifest's own
 *                                    fingerprint matches (a missing/corrupt shard
 *                                    or tampered manifest fails closed).
 *   4. `materializeSnapshot`       — decode the structural shards into a queryable
 *                                    `LoadedSnapshot` (itself fail-closed).
 *
 * Only after all four pass does a queryable snapshot exist. Every failure is a
 * TYPED reason, never a throw and never a partial read (Rule 75, fail toward
 * refusal on the vital "never serve stale context" circuit).
 */

export type LoadFreshResult =
  | { readonly ok: true; readonly snapshot: LoadedSnapshot }
  | { readonly ok: false; readonly failure: SnapshotGateFailure };

export class ProjectContextReader {
  constructor(
    private readonly store: ProjectSnapshotStore,
    private readonly merged?: MergedSnapshotSource,
  ) {}

  /**
   * The fail-closed gate: load + freshness + integrity + materialize. Returns a
   * queryable {@link LoadedSnapshot} for `requestedBaseOid`, or a typed failure.
   * A caller that has an OID in hand (the review's resolved base OID) passes it;
   * a snapshot at any other OID is refused as stale rather than served.
   */
  loadFresh(repoKey: string, requestedBaseOid: string): LoadFreshResult {
    // OID-ADDRESSABLE (issue #246): load the manifest for THIS pinned OID, not "the
    // current tip". A background rehydration that advanced the current pointer to a
    // newer OID no longer evicts this read — the per-OID manifest is still on disk, so
    // the pin stays readable instead of failing closed to `stale`. `loadManifestAt`
    // guarantees a returned manifest's `baseOid` matches the request; the freshness
    // check below stays as defense in depth (a corrupt/misnamed per-OID file).
    const manifest = this.store.loadManifestAt(repoKey, requestedBaseOid);
    if (!manifest) {
      // No readable manifest for THIS oid. Distinguish a STALE pin (a current snapshot
      // exists at a different oid — there is content, just not yours) from genuinely
      // ABSENT (nothing built, or the store is malformed). This preserves the failure
      // taxonomy consumers branch on, while the OID-addressable store keeps a still-
      // pinned oid warm rather than evicting it (#246).
      const current = this.store.loadManifest(repoKey);
      if (current) {
        const merged = this.merged?.resolveMerged(repoKey, requestedBaseOid);
        if (merged?.ok) return { ok: true, snapshot: merged.snapshot };
        return {
          ok: false,
          failure: { reason: "stale", storedBaseOid: current.baseOid, requestedBaseOid },
        };
      }
      return { ok: false, failure: { reason: "absent" } };
    }

    if (!isSnapshotFresh(manifest, requestedBaseOid)) {
      return {
        ok: false,
        failure: { reason: "stale", storedBaseOid: manifest.baseOid, requestedBaseOid },
      };
    }

    const load = (digest: string): string | undefined => this.store.loadShard(repoKey, digest);

    // Defense in depth for the "never a throw" contract (Rule 75, vital circuit):
    // `loadManifest` already deep-validates the read shape, but should any
    // malformed manifest still reach integrity/materialize (e.g. a future
    // refactor), a throw here is coerced to a TYPED `corrupt` refusal rather than
    // propagating out of the gate as an uncaught exception.
    try {
      const integrity = verifySnapshotIntegrity(manifest, load);
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

      const materialized = materializeSnapshot(manifest, load);
      if (!materialized.ok) {
        // Integrity passed but a structural shard would not decode — treat as
        // corruption (fail closed) rather than serving a partial map.
        return {
          ok: false,
          failure: { reason: "corrupt", missing: materialized.slots, mismatched: [] },
        };
      }

      return { ok: true, snapshot: materialized.snapshot };
    } catch {
      return { ok: false, failure: { reason: "corrupt", missing: [], mismatched: [] } };
    }
  }

  /**
   * `context.map` at the adapter boundary: the deterministic structural map for a
   * repo at the requested base OID, optionally scoped. Passes through the gate, so
   * a stale/absent/corrupt snapshot yields a typed failure, never a served map.
   */
  readProjectMap(
    repoKey: string,
    requestedBaseOid: string,
    scope?: ProjectMapScope,
  ): ProjectMapResult {
    const gated = this.loadFresh(repoKey, requestedBaseOid);
    if (!gated.ok) return gated;
    return { ok: true, map: queryProjectMap(gated.snapshot, scope) };
  }

  /**
   * `context.file` at the adapter boundary: what the snapshot knows about one
   * file (structural entry + symbols) at the requested base OID. Passes through
   * the gate first; a gate failure is surfaced as a `snapshot-unavailable`
   * {@link FileContextResult}-shaped refusal so a single call has one result type.
   */
  readFileContext(repoKey: string, requestedBaseOid: string, path: string): ProjectFileResult {
    const gated = this.loadFresh(repoKey, requestedBaseOid);
    if (!gated.ok) return { ok: false, reason: "snapshot-unavailable", failure: gated.failure };
    return queryFileContext(gated.snapshot, path);
  }

  /**
   * `context.overview` at the adapter boundary: a file's top-level symbol overview
   * (names/kinds/lines, no bodies) at the requested base OID, served from the same
   * per-file symbol shards `context.file` reads. Passes through the SAME
   * fail-closed gate first; a gate failure is surfaced as a `snapshot-unavailable`
   * refusal so a single call has one result type.
   */
  readFileOverview(
    repoKey: string,
    requestedBaseOid: string,
    path: string,
  ): ProjectFileOverviewResult {
    const gated = this.loadFresh(repoKey, requestedBaseOid);
    if (!gated.ok) return { ok: false, reason: "snapshot-unavailable", failure: gated.failure };
    return queryFileOverview(gated.snapshot, path);
  }

  /**
   * `context.symbol` at the adapter boundary: resolve an exported symbol name to
   * its definition site(s) at the requested base OID, over the same per-file
   * symbol shards. Passes through the SAME fail-closed gate first; a gate failure
   * is surfaced as a `snapshot-unavailable` refusal so a single call has one shape.
   */
  readSymbolDefinition(
    repoKey: string,
    requestedBaseOid: string,
    query: SymbolLookup,
  ): ProjectSymbolDefinitionResult {
    const gated = this.loadFresh(repoKey, requestedBaseOid);
    if (!gated.ok) return { ok: false, reason: "snapshot-unavailable", failure: gated.failure };
    return querySymbolDefinition(gated.snapshot, query);
  }

  /**
   * `context.references` at the adapter boundary: resolve an identifier name to its
   * occurrence site(s) at the requested base OID, over the snapshot's per-file
   * reference shards. Passes through the SAME fail-closed gate first; a gate failure
   * is surfaced as a `snapshot-unavailable` refusal so a single call has one shape.
   */
  readReferences(
    repoKey: string,
    requestedBaseOid: string,
    query: ReferenceLookup,
  ): ProjectReferenceResult {
    const gated = this.loadFresh(repoKey, requestedBaseOid);
    if (!gated.ok) return { ok: false, reason: "snapshot-unavailable", failure: gated.failure };
    return queryReferences(gated.snapshot, query);
  }
}
