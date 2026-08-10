import { classifyNovelty } from "@rennet/core";
import type { NoveltyLedger, Patchset } from "@rennet/types";
import type { ProjectContextReader, SnapshotGateFailure } from "./project-context-reader";

/**
 * The fail-closed adapter boundary for the deterministic novelty ledger (#144,
 * Stage 1). It couples the pure {@link classifyNovelty} to a real, freshness- and
 * integrity-gated snapshot: a request is pinned to the patchset's own base OID
 * (`patchset.repository.baseOid` — the same guarantee the Contracts §3.1
 * `projectSnapshotId` is meant to carry, which is not yet a field on `Patchset`),
 * and passed through {@link ProjectContextReader.loadFresh}. A STALE, ABSENT, or
 * CORRUPT snapshot yields a typed "cannot classify" ({@link NoveltyLedgerFailure}),
 * NEVER a silently-wrong ledger computed against the wrong baseline (Rule 75, the
 * vital "never consume stale context" circuit — fail toward refusal).
 *
 * This is the ONLY place the ledger touches a store; the classifier itself is a
 * pure function of an already-loaded snapshot + the diff, with no IO.
 */

/** Why the ledger could not be produced — the snapshot gate refused. */
export type NoveltyLedgerFailure = SnapshotGateFailure;

export type NoveltyLedgerResult =
  | { readonly ok: true; readonly ledger: NoveltyLedger }
  | { readonly ok: false; readonly failure: NoveltyLedgerFailure };

export class NoveltyLedgerReader {
  constructor(private readonly reader: ProjectContextReader) {}

  /**
   * Classify a patchset's changed units against the base-branch snapshot, or
   * refuse with a typed failure when a fresh, intact snapshot is not available at
   * the patchset's base OID. The pin is the patchset's `repository.baseOid`: a
   * snapshot built at any other OID is refused as `stale` rather than served, so
   * the ledger can never be computed against a mismatched baseline.
   */
  classify(repoKey: string, patchset: Patchset): NoveltyLedgerResult {
    const requestedBaseOid = patchset.repository.baseOid;
    const gated = this.reader.loadFresh(repoKey, requestedBaseOid);
    if (!gated.ok) return { ok: false, failure: gated.failure };
    return { ok: true, ledger: classifyNovelty(gated.snapshot, patchset) };
  }
}
