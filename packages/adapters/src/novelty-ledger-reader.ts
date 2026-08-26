import {
  appendGitlinkAdvances,
  classifyNovelty,
  type GitlinkEntry,
  type NoveltyResult,
} from "@rennet/core";
import type { Patchset } from "@rennet/protocol";
import { execaGit, type GitExec } from "./git-range-diff";
import type { ProjectContextReader, SnapshotGateFailure } from "./project-context-reader";
import { discoverGitlinks } from "./repo-composition-discovery";
import type { MergedSnapshotSource } from "./snapshot-overlay-generator";

/**
 * The fail-closed adapter boundary for the deterministic novelty ledger (#144,
 * Stage 1). It couples the pure {@link classifyNovelty} to a real, freshness- and
 * integrity-gated snapshot, pinned to the effective baseline the diff pack was
 * computed against.
 *
 * The pin is `patchset.projectSnapshotId` (Contracts §3.1): the base map's
 * fingerprint for a DEFAULT-base review, or the composite `(base, overlay)`
 * fingerprint for a NON-DEFAULT-base review. When present, the resolved snapshot's
 * id MUST match it or the request is refused as stale — never served against a
 * mismatched baseline (Rule 75, the vital "never consume stale context" circuit).
 * When absent, the reader falls back to the review's base OID exactly as before, so
 * the switch is additive: a diff pack that does not yet stamp `projectSnapshotId`
 * behaves identically to the wave-1 pin on `repository.baseOid`.
 *
 * For a non-default base, classification runs against the MERGED base+overlay view
 * via an injected {@link MergedSnapshotSource} (design §3); with no merged source
 * injected, a non-default base surfaces the gate's `stale` refusal unchanged. This
 * is the ONLY place the ledger touches a store; the classifier itself is a pure
 * function of an already-loaded snapshot + the diff, with no IO.
 */

/** Why the ledger could not be produced — the snapshot gate refused. */
export type NoveltyLedgerFailure = SnapshotGateFailure;

/**
 * The reader's result shape. CANONICAL as `NoveltyResult` in `@rennet/core` (so the
 * pure `context.novelty` handler can speak it without a core → adapters edge, exactly
 * as `ProjectMapResult` does for `context.map`); aliased here for stability — existing
 * importers keep resolving `NoveltyLedgerResult` from this module.
 */
export type NoveltyLedgerResult = NoveltyResult;

export class NoveltyLedgerReader {
  /**
   * @param reader the fail-closed base-map read gate.
   * @param merged OPTIONAL source of merged base+overlay snapshots for a
   *   non-default base (design §3). When absent, a non-default base surfaces the
   *   base gate's `stale` refusal unchanged (wave-1 behaviour).
   */
  constructor(
    private readonly reader: ProjectContextReader,
    private readonly merged?: MergedSnapshotSource,
  ) {}

  /**
   * Classify a patchset's changed units against the effective baseline, or refuse
   * with a typed failure. The effective baseline is the base map when the review's
   * base OID is the default (a fresh base map exists at it), or the merged
   * base+overlay view when it is a non-default base (the base map is stale at that
   * OID). When `patchset.projectSnapshotId` is present it MUST equal the resolved
   * snapshot's id, else the diff pack was computed against a different baseline and
   * the request is refused as `stale` (Rule 75).
   */
  classify(repoKey: string, patchset: Patchset): NoveltyResult {
    const requestedBaseOid = patchset.repository.baseOid;
    const pinnedId = patchset.projectSnapshotId;

    // Default-base fast path: a fresh base map AT the review's base OID is the
    // effective baseline. (Also the unchanged wave-1 path when no pin is stamped.)
    const gated = this.reader.loadFresh(repoKey, requestedBaseOid);
    if (gated.ok) {
      if (pinnedId !== undefined && pinnedId !== gated.snapshot.manifest.fingerprint) {
        return {
          ok: false,
          failure: {
            reason: "stale",
            storedBaseOid: gated.snapshot.manifest.baseOid,
            requestedBaseOid,
          },
        };
      }
      return {
        ok: true,
        ledger: classifyNovelty(gated.snapshot, patchset, gated.snapshot.manifest.fingerprint),
      };
    }

    // A base map exists but is STALE at this OID ⇒ a non-default-base review.
    // Classify against the merged base+overlay view when a merged source is wired.
    if (gated.failure.reason === "stale" && this.merged) {
      const resolved = this.merged.resolveMerged(repoKey, requestedBaseOid);
      if (!resolved.ok) return { ok: false, failure: resolved.failure };
      if (pinnedId !== undefined && pinnedId !== resolved.projectSnapshotId) {
        return {
          ok: false,
          failure: { reason: "stale", storedBaseOid: resolved.baseOid, requestedBaseOid },
        };
      }
      return {
        ok: true,
        ledger: classifyNovelty(resolved.snapshot, patchset, resolved.projectSnapshotId),
      };
    }

    // No merged source, or an absent/corrupt base map: surface the gate failure
    // unchanged (identical to wave-1 when overlay support is not wired).
    return { ok: false, failure: gated.failure };
  }

  async classifyWithGitlinks(
    repoRoot: string,
    repoKey: string,
    patchset: Patchset,
    git: GitExec = execaGit,
  ): Promise<NoveltyResult> {
    const classified = this.classify(repoKey, patchset);
    if (!classified.ok) return classified;
    let previous: readonly GitlinkEntry[];
    let current: readonly GitlinkEntry[];
    try {
      [previous, current] = await Promise.all([
        discoverGitlinks(git, repoRoot, repoKey, patchset.repository.baseOid),
        discoverGitlinks(git, repoRoot, repoKey, patchset.repository.headOid),
      ]);
    } catch {
      return classified;
    }
    return {
      ok: true,
      ledger: appendGitlinkAdvances(classified.ledger, previous, current),
    };
  }
}
