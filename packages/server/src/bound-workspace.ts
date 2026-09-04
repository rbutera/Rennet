// The one decision behind "one workspace per session" (session-bound-workspace D1).
//
// A session binds to exactly one workspace root when it is created and keeps it for its whole
// life. Everything the session spawns runs there: the six lens seats, the chat thread, the
// handoff thread, the round worker, and every cold utility turn. This module makes the choice;
// `create-server.ts` records it on the session and every later read is that recorded field.
//
// It lives outside `createServer` because the choice is the part with the interesting
// failures — two repos of one workspace on the same branch name, a branch nothing has checked
// out, a pull request whose head branch does not exist locally — and none of those are
// reachable through a composition root.

import {
  branchWorktreePath,
  ensureBranchWorktree,
  ensurePrWorktree,
  worktreeForBranch,
} from "@rennet/adapters";
import type { Review } from "@rennet/protocol";

/** `git(cwd, args)` — the locus-aware exec the daemon builds per repository. */
type GitExec = (cwd: string, args: string[], options?: { reject?: boolean }) => Promise<string>;

export interface BoundWorkspaceDeps {
  /** The daemon's git for a path, so a WSL project resolves through its own locus. */
  readonly gitFor: (root: string) => GitExec;
  /** `escapePath(realpath(root))` — the per-repository directory a branch worktree hangs under. */
  readonly repoKeyForRoot: (root: string) => string;
  /** The data dir a Rennet-created worktree lives under. */
  readonly dataDir: string;
  /** The worktree already indexed for this review's pull request, when there is one. */
  readonly prWorktreeFor: (reviewId: string) => string | undefined;
  /** Where a newly created pull-request worktree is recorded. */
  readonly recordPrWorktree: (reviewId: string, path: string) => void;
  /** The path to a review worktree for a review with no indexed one yet. */
  readonly reviewWorktreePath: (reviewId: string) => string;
  /** Fired for a worktree this call CREATED, so its `.rennet/setup` can run. */
  readonly onWorktreeCreated?: (worktreePath: string) => void;
}

/**
 * Which workspace this review's session binds to.
 *
 *   • Branch review, and some worktree of the repository already has that branch checked out
 *     (usually the reviewer's own) → THAT checkout, and no worktree is created. Asked of git
 *     rather than assumed: git refuses `worktree add` for a branch checked out elsewhere, so
 *     binding blind would fail on exactly the tree we should have bound to.
 *   • Branch review of a branch nothing has out → a Rennet-created worktree at
 *     `<dataDir>/worktrees/<repoKey>/<branch>`, with the branch CHECKED OUT, because a round
 *     commits on the session's branch there and a detached head cannot.
 *   • Pull-request snapshot → the detached worktree at the reviewed head, the one the pull
 *     request front door already ensures and indexes, re-pinned in place when the head moves.
 *
 * A working-tree capture is the degenerate branch case: its evidence IS the live checkout the
 * capture froze, and that checkout is on the branch, so it binds there without a worktree.
 *
 * Honest degrade: a worktree that cannot be ensured falls back to the repository root. The
 * task-layer prompt already teaches pinned reads (`git show <oid>:<path>`), so a seat there is
 * degraded, not lied to — and a capture is never failed by a workspace it could not create.
 *
 * The REVIEW names the repository, never a project: a workspace project holds many repos and
 * that mapping is not invertible, so `review.repositoryRoot` — stamped by whatever knew which
 * repo the row meant — is the only thing that can answer "which repo" here.
 */
export async function decideBoundWorkspace(
  review: Review,
  deps: BoundWorkspaceDeps,
): Promise<string> {
  const patchset = review.patchsets.find((entry) => entry.id === review.activePatchsetId);
  if (patchset === undefined) return review.repositoryRoot;
  const git = deps.gitFor(review.repositoryRoot);
  // Both halves of "opened from a pull request" are tested POSITIVELY: `postTarget` is present
  // exactly on a postable PR review, and `retrospective` marks the read-only PR review that
  // deliberately has none. A branch review is neither — and a PR's head branch may not exist
  // locally at all (a fork), so there is nothing to check out.
  if (review.postTarget !== undefined || review.retrospective === true) {
    const indexed = deps.prWorktreeFor(review.id);
    const worktree = indexed ?? deps.reviewWorktreePath(review.id);
    try {
      const { created } = await ensurePrWorktree(
        git,
        review.repositoryRoot,
        worktree,
        patchset.repository.headOid,
      );
      if (indexed === undefined) deps.recordPrWorktree(review.id, worktree);
      if (created) deps.onWorktreeCreated?.(worktree);
      return worktree;
    } catch {
      return review.repositoryRoot;
    }
  }
  const branch = patchset.repository.headRef;
  // A detached HEAD has no branch ref, so there is no branch to bind a worktree to.
  if (branch === undefined || branch.length === 0) return review.repositoryRoot;
  const existing = await worktreeForBranch(git, review.repositoryRoot, branch);
  if (existing !== undefined) return existing;
  const worktree = branchWorktreePath(
    deps.dataDir,
    deps.repoKeyForRoot(review.repositoryRoot),
    branch,
  );
  try {
    const { created } = await ensureBranchWorktree(git, review.repositoryRoot, worktree, branch);
    if (created) deps.onWorktreeCreated?.(worktree);
    return worktree;
  } catch {
    return review.repositoryRoot;
  }
}
