// Sibling collection (workspace-settings D5): what happens to `rennet/<branch>` and its
// worktree when the session that was working there is gone.
//
// ONE rule, asked of git, in both places it is asked: the sibling and its worktree are
// removed only when the sibling's tip is REACHABLE — from the reviewed branch, or from that
// branch's remote-tracking ref, which the push under `own` is exactly what makes true. A
// sibling holding commits neither of those has keeps its worktree AND its branch, and the
// inventory row says how far ahead it is. Nothing forces: no `--force` remove of a worktree
// with changes, no `-D` of a branch whose commits are not provably elsewhere.
//
// The two callers are the archive (the session says which sibling) and the daemon's start
// sweep (the sibling is there and no live session claims it). They share this module rather
// than each spelling the rule, because a cleanup that deletes unmerged work is not a bug
// you find in review — it is a bug you find when the commits are gone.

import {
  isAncestor,
  parseWorktreeRecords,
  refExists,
  SIBLING_BRANCH_PREFIX,
  siblingIsCollectable,
} from "@rennet/adapters";

/** `git(cwd, args)` — the locus-aware exec the daemon builds per repository. */
type GitExec = (cwd: string, args: string[], options?: { reject?: boolean }) => Promise<string>;

export interface SiblingCollection {
  /** Whether the worktree was removed. */
  readonly worktreeRemoved: boolean;
  /** Whether the sibling BRANCH was deleted with it (D5's rule held). */
  readonly branchDeleted: boolean;
  /**
   * Why, in one sentence — for the daemon log, never for a dialog. Both callers LOG it:
   * a collection that says nothing cannot be told apart from a collection that did not run,
   * which is the failure the sweep's own TDZ bug wore for a release.
   */
  readonly reason: string;
}

/** The reviewed branch a sibling was forked from, or nothing when this is not a sibling. */
export function branchBehindSibling(workBranch: string | undefined): string | undefined {
  if (workBranch === undefined || !workBranch.startsWith(SIBLING_BRANCH_PREFIX)) return undefined;
  const branch = workBranch.slice(SIBLING_BRANCH_PREFIX.length);
  return branch.length > 0 ? branch : undefined;
}

/**
 * Collect one sibling, or keep it and say why (D5).
 *
 * The worktree goes FIRST and only then the branch, because git refuses to delete a branch
 * that a worktree has checked out — so a failed removal leaves both, which is the right
 * answer anyway: something is in that directory.
 *
 * `-d` before `-D` for the same reason `removeWorkspace` does it: `-d` measures merged into
 * whatever HEAD the clone happens to have out, which is a different and weaker question
 * than D5's, so it is tried first and `-D` is reached only once ancestry has already been
 * proven above. `git branch` takes the SHORT name deliberately — it deletes branches and
 * only branches, so the tag that could shadow `rennet/feat/x` in a revision walk cannot be
 * deleted by it, and git rejects a `refs/heads/…` argument here outright.
 */
export async function collectSibling(input: {
  readonly git: GitExec;
  readonly repoRoot: string;
  /** `rennet/<branch>` — the short name; every ancestry question below qualifies it. */
  readonly siblingBranch: string;
  /** The reviewed branch it was forked from. */
  readonly branch: string;
  /**
   * The sibling's worktree, in GIT's spelling. Absent ⇒ ASKED OF GIT, which is the only
   * source that has it: the session records the DAEMON's spelling of its bound root, and
   * on a Windows daemon driving a WSL repository that is a UNC path the git inside the
   * distro does not own. `worktree remove` handed that path refuses every time, so the
   * sibling would never be collected on exactly the arrangement that most needs it.
   */
  readonly worktreePath?: string;
  /**
   * Where the session's push went, when the session recorded one (D4). Given, only that
   * remote's tracking ref answers the reachability question; absent (the sweep, which has
   * no session to ask), every remote's does. It is never a timestamp: `siblingIsCollectable`
   * reads refs, so a force-push or a deleted remote branch changes the answer.
   */
  readonly push?: { readonly remote: string };
}): Promise<SiblingCollection> {
  const { git, repoRoot, siblingBranch, branch } = input;
  if (!(await refExists(git, repoRoot, `refs/heads/${siblingBranch}`))) {
    return { worktreeRemoved: false, branchDeleted: false, reason: `${siblingBranch} is gone` };
  }
  if (!(await siblingIsCollectable(git, repoRoot, siblingBranch, branch, input.push))) {
    return {
      worktreeRemoved: false,
      branchDeleted: false,
      reason: `${siblingBranch} holds commits ${branch} does not — kept with its worktree`,
    };
  }
  const worktreePath = input.worktreePath ?? (await worktreeOnBranch(git, repoRoot, siblingBranch));
  let worktreeRemoved = false;
  if (worktreePath !== undefined) {
    try {
      await git(repoRoot, ["worktree", "remove", worktreePath], { reject: true });
      worktreeRemoved = true;
    } catch {
      // Git refused: something is in that directory. The branch stays too — it is checked
      // out there, and deleting the ref under a live worktree is not a thing to attempt.
      return {
        worktreeRemoved: false,
        branchDeleted: false,
        reason: `${siblingBranch}'s worktree could not be removed — both kept`,
      };
    }
  }
  for (const flag of ["-d", "-D"]) {
    try {
      await git(repoRoot, ["branch", flag, siblingBranch], { reject: true });
      return {
        worktreeRemoved,
        branchDeleted: true,
        reason: `${siblingBranch} is reachable from ${branch} — removed`,
      };
    } catch {
      // `-d` refuses on a branch not merged into the CLONE's current HEAD, which is a
      // different question from D5's and already answered above. `-D` follows.
    }
  }
  return {
    worktreeRemoved,
    branchDeleted: false,
    reason: `${siblingBranch} could not be deleted — kept`,
  };
}

/** Git's own spelling of the worktree that has `branch` checked out, or nothing. */
async function worktreeOnBranch(
  git: GitExec,
  repoRoot: string,
  branch: string,
): Promise<string | undefined> {
  const listed = await git(repoRoot, ["worktree", "list", "--porcelain", "-z"], {
    reject: false,
  }).catch(() => "");
  return parseWorktreeRecords(listed).find((record) => record.branch === branch)?.path;
}

/** One sibling worktree the sweep found: git's spelling of its path, and its branch. */
export interface OrphanedSibling {
  readonly path: string;
  readonly siblingBranch: string;
  readonly branch: string;
}

/**
 * Every `rennet/*` worktree of `repoRoot` that sits under `root` and that NO live session
 * claims — the sweep's candidates.
 *
 * The candidate rule is a PREFIX on the branch name and nothing more: any worktree whose
 * ref starts `rennet/` counts. That is deliberate and it is stated rather than tightened —
 * the prefix is Rennet's namespace, the reviewed branch it was forked from is whatever
 * follows it, and a repository where a human made their own `rennet/…` branch and gave it
 * a worktree under Rennet's own worktree root has already opted into this. What protects
 * that worktree is not the candidate rule but `collectSibling`'s: an unreachable sibling
 * keeps its worktree AND its branch.
 *
 * `claimedPaths` is compared as git spells it, because that is what this list is built from
 * and what the removal is handed. A path a live session records under another spelling is
 * the WSL arrangement, and the caller passes both spellings for exactly that reason: a
 * missed match here does not leave a stale directory, it DELETES a workspace someone is
 * working in.
 */
export async function orphanedSiblings(input: {
  readonly git: GitExec;
  readonly repoRoot: string;
  readonly under: (path: string) => boolean;
  readonly claimed: (path: string) => boolean;
}): Promise<OrphanedSibling[]> {
  const listed = await input
    .git(input.repoRoot, ["worktree", "list", "--porcelain", "-z"], { reject: false })
    .catch(() => "");
  const found: OrphanedSibling[] = [];
  for (const record of parseWorktreeRecords(listed)) {
    if (record.bare || record.branch === undefined) continue;
    if (!record.branch.startsWith(SIBLING_BRANCH_PREFIX)) continue;
    if (!input.under(record.path) || input.claimed(record.path)) continue;
    const branch = record.branch.slice(SIBLING_BRANCH_PREFIX.length);
    if (branch.length === 0) continue;
    found.push({ path: record.path, siblingBranch: record.branch, branch });
  }
  return found;
}

/**
 * Is `siblingBranch` reachable from `branch` alone? Exported for the tests that pin D5's
 * two halves apart — a sibling reachable only through the REMOTE-tracking ref is collected
 * (the push under `own` put its commits there) and is NOT reachable locally.
 */
export function siblingReachableLocally(
  git: GitExec,
  repoRoot: string,
  siblingBranch: string,
  branch: string,
): Promise<boolean> {
  return isAncestor(git, repoRoot, `refs/heads/${siblingBranch}`, `refs/heads/${branch}`);
}
