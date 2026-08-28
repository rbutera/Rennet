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
import {
  type Claim,
  claimMatchesTarget,
  type Project,
  type Review,
  type SessionModel,
} from "@rennet/protocol";

// The claim-match rule moved to `@rennet/protocol` (C21) so the client's New-Chat row-hide
// decides with the SAME predicate this reattach does; re-exported here for its callers.
export { claimMatchesTarget };

/** A target a New-chat row resolves to: a branch and, when known, its PR number.
 *  The `Claim` the session binds is this same pair (branch + optional PR). */
export interface Target {
  readonly branch: string;
  readonly prNumber?: number;
  /**
   * The row's `owner/name` repository identity, when the caller named one (#580). A workspace
   * holds several repos and a branch name is unique only within one, so this is what keeps two
   * repos that both have `main` from collapsing into a single session. It is deliberately NOT
   * part of the `Claim` — `claimMatchesTarget` is shared with the client's row-hide and its
   * semantics are untouched here; the discrimination happens in {@link claimingSession}.
   */
  readonly repository?: string;
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
 * The `Project.id` a repository root belongs to — the ONE key both session mints converge on
 * (#580). The client's New Chat mint always had a `Project.id`; the round dispatch used to mint
 * with the repo root instead, and a `Project.id` is a `crypto.randomUUID()` stamped at add time,
 * so the two keys could never coincide and a round-minted session grouped under NO sidebar row.
 *
 * SOURCE-SCOPED to `local`: `Project.source` names the daemon a project lives on, so a `wsl:` or
 * `remote:` project can carry the very same path as a local one. A review this daemon captured
 * runs against a path on THIS host, so only local projects can cover it.
 *
 * No stored project covers the root ⇒ the root itself, deliberately. There is genuinely no
 * project row to group under, so the session is honestly ungrouped (exactly today's behaviour)
 * rather than filed under a project that does not contain it.
 */
export function projectIdForRepoRoot(repoRoot: string, projects: readonly Project[]): string {
  const covering = projects.find(
    (p) =>
      p.source === "local" &&
      (p.openPath === repoRoot ||
        p.path === repoRoot ||
        (p.includedRepoPaths ?? []).includes(repoRoot)),
  );
  return covering?.id ?? repoRoot;
}

/**
 * The live session claiming a target IN a project, repo-precise (#580). ONE matcher, so the
 * round dispatch's mint-or-reattach and the read-side {@link resolveRoundSessionId} cannot
 * disagree about which session owns a target — a disagreement empties the rounds ledger, the
 * transcript and the board read simultaneously, because all three key on the session id.
 *
 * Two keys, because one is not enough:
 *   • `projectId` is the SIDEBAR GROUPING key (a `Project.id`). Both mints converge on it, and
 *     that convergence is what puts a round-minted session under a project row at all.
 *   • `repositoryRoot` keeps the match REPO-PRECISE. A workspace project holds many repos, so
 *     project id → repo is many-to-one and NOT invertible; matching on the project alone would
 *     let two repos in one workspace that share a branch name resolve to each other's sessions
 *     and collapse their per-repo rounds into a single ledger.
 *
 * A caller that does not KNOW the root passes `undefined`, and the New Chat mint is exactly
 * that: its row carries a branch and an `owner/name`, never a path (host paths do not cross the
 * wire, R19). That is why `Target.repository` exists as the THIRD discriminator: a row already
 * knows which repo of the workspace it names, so two same-named branches in one workspace no
 * longer collapse into one session. The first round dispatch then stamps the real root in place.
 *
 * The three matches are deliberately asymmetric, because over-tightening is the worse failure —
 * it stops existing sessions resolving, which is the four-empty-reads bug this lane exists to
 * close. So a session is EXCLUDED only when it positively contradicts the caller:
 *   • caller names no repository ⇒ nothing is excluded (exactly pre-#580 behaviour);
 *   • session carries no repository ⇒ it still matches (an older or unstamped session resolves);
 *   • session carries a DIFFERENT repository ⇒ excluded, because it is provably another repo's.
 * Among the survivors, an exact repo ROOT wins over an unstamped session, and a session stamped
 * for another root never wins at all. The unstamped fallback is taken only when there is exactly
 * ONE — see below; an ambiguous fallback is declined rather than guessed.
 *
 * The two identities are complementary rather than redundant, and neither caller has both: the
 * New Chat mint knows the `owner/name` (it is on the row) and can never know a host path; the
 * round dispatch knows the path and cannot derive an `owner/name` synchronously (that is a git
 * remote read). The consequence is stated rather than hidden: in a workspace holding two repos
 * that share a branch name, a session minted from a row and the session a later round dispatches
 * onto can be two rows rather than one. That is an honest split, not a wrong answer — the
 * alternative, guessing, files one repo's rounds under the other repo's session.
 */
export function claimingSession(
  sessions: readonly SessionModel[],
  projectId: string,
  repositoryRoot: string | undefined,
  target: Target,
): SessionModel | undefined {
  const live = sessions.filter(
    (s) =>
      s.archivedAt === undefined &&
      s.projectId === projectId &&
      s.claim !== undefined &&
      claimMatchesTarget(s.claim, target) &&
      // Excluded only on a positive contradiction — never on either side's silence.
      (target.repository === undefined ||
        s.repository === undefined ||
        s.repository === target.repository),
  );
  if (repositoryRoot === undefined) return live[0];
  // An exact repo match wins; an UNSTAMPED session is the fallback (a New Chat mint that could
  // not know the root), never a session stamped for a DIFFERENT repo in the same workspace.
  //
  // The fallback is taken only when it is UNAMBIGUOUS. Two unstamped sessions on one claim exist
  // precisely because they named different repositories (identical silence would have reattached,
  // not minted), and this caller has a PATH and no `owner/name`, so it can exclude neither. Taking
  // the first would be decided by store order — a coin flip that files this repo's rounds under
  // the other repo's session and then stamps this root onto it, leaving a session claiming to be
  // both repos at once. Declining is honest and self-healing: the dispatch mints its own session,
  // root-stamped, which resolves exactly from the next read on.
  const unstamped = live.filter((s) => s.repositoryRoot === undefined);
  return (
    live.find((s) => s.repositoryRoot === repositoryRoot) ??
    (unstamped.length === 1 ? unstamped[0] : undefined)
  );
}

/**
 * The session id a round for this review dispatched onto — the READ side of dispatchRound's
 * mint (B9/B10 seam). A round serializes on the SessionEntry session claiming the review's
 * target (branch + PR); this resolves that same session id READ-ONLY (never minting), so the
 * `session.rounds` ledger, the `session.transcript` rows and the `board.read` lens board all
 * line up with what a dispatch recorded. Mirrors dispatchRound's derivation exactly: the
 * project id + repo root + the active patchset's branch (+ PR) is the key; a detached HEAD (no
 * branch) or no claiming session yet ⇒ the review id, the identical fallback dispatchRound uses.
 *
 * `projectId` is the caller's — the SAME {@link projectIdForRepoRoot} lookup the dispatch runs,
 * passed in rather than re-derived, so this stays a pure function of the session records.
 */
export function resolveRoundSessionId(
  review: Review,
  sessions: readonly SessionModel[],
  projectId: string,
): string {
  const activePatchset = review.patchsets.find((p) => p.id === review.activePatchsetId);
  const branch = activePatchset?.repository.headRef;
  if (branch === undefined) return review.id;
  const target: Target = {
    branch,
    ...(review.postTarget ? { prNumber: review.postTarget.number } : {}),
  };
  return claimingSession(sessions, projectId, review.repositoryRoot, target)?.id ?? review.id;
}

/** Mints and reattaches sessions from New-chat row clicks, and hides the rows a
 *  live claim already owns. Wired into the dispatch session/review family by the
 *  cluster-6 composition root; standalone + tested here. */
export class SessionEntry {
  constructor(
    private readonly store: EntryStore,
    private readonly mintDeps: MintSessionDeps = {},
  ) {}

  /**
   * A row-click (or a round dispatch) resolving to a target: REATTACH to the session already
   * claiming it, or mint a fresh session and bind the claim in ONE act. Idempotent per target —
   * a second entry (even mid-generation) reattaches, never mints a second session. The claim is
   * project-scoped (F5): `feat/x` or PR #7 in project A never cross-attaches to the same-named
   * target in project B. The claim survives merge; only archive clears it.
   *
   * Two repo facts ride along, and each is stamped on the mint AND stamped IN PLACE on a
   * reattach to a session that lacked it — so a session converges on the full truth as callers
   * that know more reach it, rather than staying half-identified forever:
   *   • `repositoryRoot`, the path the work runs in, known to the round dispatch and not to the
   *     New Chat mint (a row carries no host path).
   *   • `target.repository`, the `owner/name` identity, known to the New Chat mint (it is on the
   *     row) and not derivable synchronously from a path on the dispatch side.
   */
  enter(projectId: string, target: Target, repositoryRoot?: string): EntryResult {
    const existing = claimingSession(this.store.list(), projectId, repositoryRoot, target);
    if (existing !== undefined) {
      const stamp: Partial<SessionModel> = {
        ...(repositoryRoot !== undefined && existing.repositoryRoot === undefined
          ? { repositoryRoot }
          : {}),
        ...(target.repository !== undefined && existing.repository === undefined
          ? { repository: target.repository }
          : {}),
      };
      if (Object.keys(stamp).length === 0) return { session: existing, reattached: true };
      const stamped: SessionModel = { ...existing, ...stamp };
      this.store.save(stamped);
      return { session: stamped, reattached: true };
    }
    const claim: Claim = {
      branch: target.branch,
      ...(target.prNumber === undefined ? {} : { prNumber: target.prNumber }),
    };
    const session = bindTarget(
      {
        ...mintSession(projectId, this.mintDeps),
        ...(repositoryRoot === undefined ? {} : { repositoryRoot }),
        ...(target.repository === undefined ? {} : { repository: target.repository }),
      },
      claim,
    );
    this.store.save(session);
    return { session, reattached: false };
  }

  /**
   * The detached-HEAD round's session (#573). No branch means no claim to dedupe on, so the
   * REVIEW id is the key: stable per review, so a re-dispatch serializes onto the same session
   * and `resolveRoundSessionId`'s no-branch fallback resolves the very same id.
   *
   * The point of this method is that it SAVES. The defect it replaces built an ad-hoc session
   * literal that was never persisted, so the per-session round lock, the rounds ledger, the
   * harness cursor + transcript, and the `(session, generation)` board-idempotency record were
   * all filed under an id no read path could resolve and no sidebar could list — work recorded
   * under an identity the product cannot look up.
   */
  enterDetached(projectId: string, reviewId: string, repositoryRoot: string): EntryResult {
    const existing = this.store.list().find((s) => s.id === reviewId);
    if (existing !== undefined) return { session: existing, reattached: true };
    const session: SessionModel = {
      id: reviewId,
      projectId,
      repositoryRoot,
      threads: [],
      createdAt: (this.mintDeps.now ?? (() => Date.now()))(),
    };
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
