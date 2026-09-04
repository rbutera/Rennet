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

import { realpathSync } from "node:fs";
import {
  branchWorktreePath,
  ensureBranchWorktree,
  ensurePrWorktree,
  prWorktreePath,
  worktreeForBranch,
} from "@rennet/adapters";
import { type Locus, toWindowsView } from "@rennet/core";
import type { Review } from "@rennet/protocol";

/** `git(cwd, args)` — the locus-aware exec the daemon builds per repository. */
type GitExec = (cwd: string, args: string[], options?: { reject?: boolean }) => Promise<string>;

export interface BoundWorkspaceDeps {
  /** The daemon's git for a path, so a WSL project resolves through its own locus. */
  readonly gitFor: (root: string) => GitExec;
  /** The repository's execution locus, which decides how git's own paths are spelled. */
  readonly locusOf: (root: string) => Locus;
  /** `escapePath(realpath(root))` — the per-repository directory a branch worktree hangs under. */
  readonly repoKeyForRoot: (root: string) => string;
  /** The data dir a Rennet-created worktree lives under. */
  readonly dataDir: string;
  /** The worktree already indexed for this review's pull request, when there is one. */
  readonly prWorktreeFor: (reviewId: string) => string | undefined;
  /** Where a newly created pull-request worktree is recorded. */
  readonly recordPrWorktree: (reviewId: string, path: string) => void;
  /** Fired for a worktree this call CREATED, so its `.rennet/setup` can run. */
  readonly onWorktreeCreated?: (worktreePath: string) => void;
}

/**
 * Re-spell a path GIT printed into the spelling the DAEMON uses for this repository.
 *
 * They differ in exactly one arrangement, and it is a live one (task 5.2, PR #789): a daemon on
 * Windows driving a WSL-locus project addresses the repository as `\\wsl$\Ubuntu\home\u\repo`,
 * while the git it runs lives inside the distro and answers `/home/u/repo`. Storing git's answer
 * as `boundRoot` would make `existsSync` refuse every thread, `detectLocus` read the path as the
 * HOST, and the context writer mkdir `C:\home\u\…`.
 *
 * Only that arrangement is rewritten. A daemon running INSIDE the distro already addresses the
 * repository the way git does, and a host-locus repository never had two spellings.
 */
export function comparablePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Whether two paths name the SAME directory: resolved through symlinks, so `/var/x` and
 * `/private/var/x` are one, and compared case-insensitively on the UNC forms where Windows is.
 * An unresolvable path keeps its literal form, which still compares equal to itself.
 */
export function sameDirectory(a: string, b: string): boolean {
  if (a === b) return true;
  const [left, right] = [comparablePath(a), comparablePath(b)];
  return left === right || left.toLowerCase() === right.toLowerCase();
}

export function inRepoSpelling(gitPath: string, repositoryRoot: string, locus: Locus): string {
  if (locus.kind !== "wsl") return gitPath;
  // The daemon is inside the distro when it addresses the repository distro-natively; then git's
  // spelling is already the daemon's, and re-spelling it would invent a UNC path nothing uses.
  if (repositoryRoot.startsWith("/")) return gitPath;
  if (!gitPath.startsWith("/")) return gitPath; // already a UNC/Windows path
  return toWindowsView(gitPath, locus.distro);
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
 * **A workspace that cannot be created THROWS.** It does not fall back to the clone. The clone
 * sits on whatever ref it sits on — usually the default branch — so a recorded fallback would
 * bind the session to the wrong branch for its whole life and every turn afterwards would read,
 * draft and commit against a tree the review is not about, silently and under the right label.
 * The caller records nothing on a throw, so the next use retries: "could not bind, try again" is
 * a fact reported, not a gate asked.
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
  // Nothing pinned: there is no reviewed tree to bind to and nothing to create, so the
  // repository itself is the only honest answer.
  if (patchset === undefined) return review.repositoryRoot;
  const git = deps.gitFor(review.repositoryRoot);
  const locus = deps.locusOf(review.repositoryRoot);
  // Both halves of "opened from a pull request" are tested POSITIVELY: `postTarget` is present
  // exactly on a postable PR review, and `retrospective` marks the read-only PR review that
  // deliberately has none. A branch review is neither — and a PR's head branch may not exist
  // locally at all (a fork), so there is nothing to check out.
  if (review.postTarget !== undefined || review.retrospective === true) {
    return ensurePrSnapshotWorkspace(review, patchset.repository.headOid, git, deps);
  }
  const branch = patchset.repository.headRef;
  // A detached HEAD has no branch ref, so there is no branch to bind a worktree to.
  if (branch === undefined || branch.length === 0) return review.repositoryRoot;
  const worktree = branchWorktreePath(
    deps.dataDir,
    deps.repoKeyForRoot(review.repositoryRoot),
    branch,
  );
  const existing = await worktreeForBranch(git, review.repositoryRoot, branch);
  if (existing !== undefined) {
    // PREFER A SPELLING RENNET ALREADY OWNS. `git worktree list` prints a realpath, and on WSL
    // the UNC form it maps back to is `\\\\wsl.localhost\\…` while a project may be opened as
    // `\\\\wsl$\\…`. Either would make `boundRoot` differ from the name Rennet already has for
    // this directory — the repository root, or the worktree Rennet itself created — by
    // SPELLING ALONE. Downstream that reads as "this session moved to another workspace": it
    // retires the session's thread rows and re-keys the new ones on the alternate name. Same
    // directory, same string, whichever of the two owns it.
    if (sameDirectory(existing, review.repositoryRoot)) return review.repositoryRoot;
    if (sameDirectory(existing, worktree)) return worktree;
    // A worktree the reviewer made themselves: git's spelling is all there is, re-spelled into
    // the locus the daemon addresses the repository by.
    return inRepoSpelling(existing, review.repositoryRoot, locus);
  }
  const { created } = await ensureBranchWorktree(git, review.repositoryRoot, worktree, branch);
  if (created) deps.onWorktreeCreated?.(worktree);
  return worktree;
}

/**
 * Re-pin a workspace a session is ALREADY bound to, without re-deciding which one it is.
 *
 * A landed round advances the reviewed head, and a pull-request snapshot's workspace is a
 * DETACHED checkout at the old one — so without this every generation after the first drafts
 * from the previous patchset's bytes while the bench says otherwise. `ensurePrWorktree` replaces
 * the checkout in place at the same path, so the session's `boundRoot` never moves.
 *
 * A branch binding needs nothing: its worktree has the branch checked out, so it follows the
 * ref. A failure throws for the same reason a first bind does — a stale tree is the wrong tree.
 */
export async function repinBoundWorkspace(
  review: Review,
  recorded: string,
  deps: Pick<BoundWorkspaceDeps, "gitFor">,
): Promise<string> {
  if (review.postTarget === undefined && review.retrospective !== true) return recorded;
  const patchset = review.patchsets.find((entry) => entry.id === review.activePatchsetId);
  if (patchset === undefined) return recorded;
  // The repository is where the worktree hangs off; `recorded` is the worktree itself.
  if (recorded === review.repositoryRoot) return recorded;
  await ensurePrWorktree(
    deps.gitFor(review.repositoryRoot),
    review.repositoryRoot,
    recorded,
    patchset.repository.headOid,
  );
  return recorded;
}

/**
 * The detached worktree at a pull request's reviewed head, ensured every time.
 *
 * Ensured, not merely read: a landed round advances the reviewed head, and `ensurePrWorktree`
 * replaces a superseded checkout in place at the SAME path. That is why this runs again for an
 * already-recorded binding — it is a re-pin of one workspace, never a re-decision of which
 * workspace, so the session's `boundRoot` does not move.
 *
 * The path is the per-pull-request one (`<dataDir>/worktrees/<owner>/<repo>/pr-N`), the same one
 * the pull-request front door writes; a review with neither an index entry nor a post target
 * (only reachable when the front door's own ensure failed) has no way to name one and binds to
 * the repository, which for a pull-request clone is where its pinned reads already resolve.
 */
async function ensurePrSnapshotWorkspace(
  review: Review,
  headOid: string,
  git: GitExec,
  deps: BoundWorkspaceDeps,
): Promise<string> {
  const indexed = deps.prWorktreeFor(review.id);
  const target =
    indexed ??
    (review.postTarget === undefined
      ? undefined
      : prWorktreePath(deps.dataDir, review.postTarget.repo, review.postTarget.number));
  if (target === undefined) return review.repositoryRoot;
  const { created } = await ensurePrWorktree(git, review.repositoryRoot, target, headOid);
  if (indexed === undefined) deps.recordPrWorktree(review.id, target);
  if (created) deps.onWorktreeCreated?.(target);
  return target;
}
