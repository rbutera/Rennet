// ─────────────────────────────────────────────────────────────────────────────
// Row-click session entry: mint-or-reattach + claim-dedup (#466 res. 11, B09 cluster 5).
//
// A New-chat row resolving to a branch/PR mints a session AND claims the target in
// ONE act: a branch and its PR are ONE claimed thing (`Claim`). Every New-chat row
// resolving to either the branch or the PR DISAPPEARS while the claim holds
// (claim-dedup on resolve). Re-entering a row whose target is already claimed
// REATTACHES to that session — it never mints a second (task 5.2). Archive is the
// only release (cluster 1 semantics); a merged target keeps its claim, because the
// filter keys on `archivedAt`, never on merge state.
//
// Synchronous by construction: the store's load/save are sync (file store) and
// mint→bind→save is one uninterrupted act, so two entries for one target cannot
// interleave into two sessions — no lock needed. The sessions ARE separate per
// claim; nothing is shared to serialize.
// ─────────────────────────────────────────────────────────────────────────────

import { bindTarget, type MintSessionDeps, mintSession } from "@rennet/core";
import { type Claim, claimMatchesTarget, type Review, type SessionModel } from "@rennet/protocol";

// The claim-match rule moved to `@rennet/protocol` (C21) so the client's New-Chat row-hide
// decides with the SAME predicate this reattach does; re-exported here for its callers.
export { claimMatchesTarget };

/** A target a New-chat row resolves to: a branch and, when known, its PR number.
 *  The `Claim` the session binds is this same pair (branch + optional PR). */
export interface Target {
  readonly branch: string;
  readonly prNumber?: number;
}

/** The session persistence entry reads claims from and writes new sessions to.
 *  The file-backed `SessionStore` (adapters) satisfies this; tests pass a fake. */
export interface EntryStore {
  list(): SessionModel[];
  save(session: SessionModel): void;
}

/** The result of entering a target: the session, and whether it was reattached
 *  (an existing live claim) rather than freshly minted. */
export interface EntryResult {
  readonly session: SessionModel;
  readonly reattached: boolean;
}

/**
 * The session id a round for this review dispatched onto — the READ side of dispatchRound's
 * mint (B9/B10 seam). A round serializes on the SessionEntry session claiming the review's
 * target (branch + PR); this resolves that same session id READ-ONLY (never minting), so the
 * `session.rounds` ledger read lines up with what a dispatch recorded. Mirrors dispatchRound's
 * derivation exactly: the active patchset's branch (+ PR) is the target; a detached HEAD (no
 * branch) or no claiming session yet ⇒ the review id, the identical fallback dispatchRound uses.
 */
export function resolveRoundSessionId(review: Review, sessions: readonly SessionModel[]): string {
  const activePatchset = review.patchsets.find((p) => p.id === review.activePatchsetId);
  const branch = activePatchset?.repository.headRef;
  if (branch === undefined) return review.id;
  const target: Target = {
    branch,
    ...(review.postTarget ? { prNumber: review.postTarget.number } : {}),
  };
  const claiming = sessions.find(
    (s) =>
      s.archivedAt === undefined &&
      s.projectId === review.repositoryRoot &&
      s.claim !== undefined &&
      claimMatchesTarget(s.claim, target),
  );
  return claiming?.id ?? review.id;
}

/** Mints and reattaches sessions from New-chat row clicks, and hides the rows a
 *  live claim already owns. Wired into the dispatch session/review family by the
 *  cluster-6 composition root; standalone + tested here. */
export class SessionEntry {
  constructor(
    private readonly store: EntryStore,
    private readonly mintDeps: MintSessionDeps = {},
  ) {}

  /** The live claim owning this target WITHIN a project, if any — a non-archived
   *  session in the SAME project whose claim matches (branch or PR). A claim is
   *  project-scoped: `feat/x` or PR #7 in project A must never cross-attach to the
   *  same-named target in project B (F5). The claim survives merge; only archive clears it. */
  #claiming(projectId: string, target: Target): SessionModel | undefined {
    return this.store
      .list()
      .find(
        (s) =>
          s.archivedAt === undefined &&
          s.projectId === projectId &&
          s.claim !== undefined &&
          claimMatchesTarget(s.claim, target),
      );
  }

  /**
   * A row-click resolving to a target: REATTACH to the session already claiming it,
   * or mint a fresh session and bind the claim in ONE act. Idempotent per target —
   * a second click (even mid-generation) reattaches, never mints a second session.
   */
  enter(projectId: string, target: Target): EntryResult {
    const existing = this.#claiming(projectId, target);
    if (existing !== undefined) return { session: existing, reattached: true };
    const claim: Claim = {
      branch: target.branch,
      ...(target.prNumber === undefined ? {} : { prNumber: target.prNumber }),
    };
    const session = bindTarget(mintSession(projectId, this.mintDeps), claim);
    this.store.save(session);
    return { session, reattached: false };
  }

  /**
   * Claim-dedup on resolve, scoped to a project (F5): the New-chat rows that
   * SURVIVE — the candidates whose target no live claim IN THIS PROJECT already
   * owns. A claim in another project never hides a same-named target here. A
   * claimed target's rows disappear while the claim holds (archive is the only release).
   */
  visibleTargets(projectId: string, candidates: readonly Target[]): Target[] {
    const claims = this.store
      .list()
      .filter(
        (s) => s.archivedAt === undefined && s.projectId === projectId && s.claim !== undefined,
      )
      .map((s) => s.claim as Claim);
    return candidates.filter((t) => !claims.some((c) => claimMatchesTarget(c, t)));
  }
}
