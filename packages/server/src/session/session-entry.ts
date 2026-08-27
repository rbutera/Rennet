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
import type { Claim, SessionModel } from "@rennet/protocol";

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
 * A branch and its PR are ONE claimed thing (#466 res. 11): a target matches a
 * claim when the branch matches OR the PR number matches. So a row resolving to
 * the PR disappears behind a session that claimed the branch, and vice versa.
 */
export function claimMatchesTarget(claim: Claim, target: Target): boolean {
  if (claim.branch === target.branch) return true;
  return claim.prNumber !== undefined && claim.prNumber === target.prNumber;
}

/** Mints and reattaches sessions from New-chat row clicks, and hides the rows a
 *  live claim already owns. Wired into the dispatch session/review family by the
 *  cluster-6 composition root; standalone + tested here. */
export class SessionEntry {
  constructor(
    private readonly store: EntryStore,
    private readonly mintDeps: MintSessionDeps = {},
  ) {}

  /** The live claim owning this target, if any — a non-archived session whose
   *  claim matches (branch or PR). The claim survives merge; only archive clears it. */
  #claiming(target: Target): SessionModel | undefined {
    return this.store
      .list()
      .find(
        (s) =>
          s.archivedAt === undefined &&
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
    const existing = this.#claiming(target);
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
   * Claim-dedup on resolve: the New-chat rows that SURVIVE — the candidates whose
   * target no live claim already owns. A claimed target's rows disappear while the
   * claim holds (archive is the only release).
   */
  visibleTargets(candidates: readonly Target[]): Target[] {
    const claims = this.store
      .list()
      .filter((s) => s.archivedAt === undefined && s.claim !== undefined)
      .map((s) => s.claim as Claim);
    return candidates.filter((t) => !claims.some((c) => claimMatchesTarget(c, t)));
  }
}
