// Where the round's commits have got to (workspace-settings D4) — READ FROM GIT, at the
// moment the question is asked.
//
// This replaced a durable `workBranchPushedAt` stamp on the session record, and the reason
// is the whole point of the module. A stamp says a push once succeeded. Every sentence the
// surface actually wants to write is about what the refs hold NOW:
//
//   • "`feat/x` is behind `origin/feat/x` by 2" stops being true the moment the reviewer
//     pulls, or lands the sibling, or force-pushes something else.
//   • "The round's commits are on `rennet/feat/x`" stops being true the moment they land.
//
// The stamp could not stop being true, so the card went on saying "behind its upstream"
// over a branch that had caught up — the "lie in the UI" family. Four ref reads answer all
// of it, they cost nothing, and they cannot be stale.
//
// Every ref is FULLY QUALIFIED. `rev-parse rennet/feat/x` resolves `refs/tags/` before
// `refs/heads/`, so a tag of that name would answer the ahead/pushed/landed questions for a
// branch it has nothing to do with — the same trap `siblingIsCollectable` and the land
// action each spell out, for the same reason.

import { isAncestor, refExists } from "@rennet/adapters";

/** `git(cwd, args)` — the locus-aware exec the daemon builds per repository. */
type GitExec = (cwd: string, args: string[], options?: { reject?: boolean }) => Promise<string>;

/** What the surface renders beside the session's branch. Every field a ref question. */
export interface WorkBranchState {
  /** The reviewed branch, when the session knows one. */
  readonly branch?: string;
  /** The branch the work commits on. Absent, or equal to `branch`, ⇒ nothing to say. */
  readonly workBranch?: string;
  /** Commits the work branch holds that the reviewed branch does not. */
  readonly ahead: number;
  /** The work branch's tip is reachable from the recorded push destination's ref. */
  readonly pushed: boolean;
  /** The reviewed branch is already AT the work branch's tip. */
  readonly landed: boolean;
  /** The remote-tracking ref `pushed` was decided against — named, never called "upstream". */
  readonly remoteRef?: string;
}

/** Nothing to say: no work branch, no session, or the work is on the reviewed branch. */
const QUIET = { ahead: 0, pushed: false, landed: false } as const;

/**
 * Read one session's work-branch state.
 *
 * `push` is where the session's pull-request submission actually pushed — the remote and
 * the branch name it landed under. It is the ONLY thing that decides `pushed`, and it is a
 * recorded destination rather than a configured upstream on purpose: Rennet's push sets no
 * upstream (no `-u`), so `<branch>@{upstream}` was empty on every repository this question
 * is asked about, and the answer was permanently false.
 *
 * A session that has not pushed reports `pushed: false` and carries no `remoteRef`. That is
 * an honest absence — Rennet has not sent these commits anywhere — and it is different from
 * "pushed and then overtaken", which reports `pushed: true` with the ref named.
 */
export async function readWorkBranchState(input: {
  readonly git: GitExec;
  readonly repoRoot: string;
  readonly branch?: string;
  readonly workBranch?: string;
  readonly push?: { readonly remote: string; readonly branch: string };
}): Promise<WorkBranchState> {
  const { git, repoRoot, branch, workBranch } = input;
  if (branch === undefined || workBranch === undefined || workBranch === branch) {
    return {
      ...QUIET,
      ...(branch === undefined ? {} : { branch }),
      ...(workBranch === undefined ? {} : { workBranch }),
    };
  }
  const branchRef = `refs/heads/${branch}`;
  const workRef = `refs/heads/${workBranch}`;
  const base = { branch, workBranch };
  // The work branch has to exist for any of the rest to mean anything. A collected sibling
  // is gone, and reporting it as "not landed, not pushed, 0 ahead" would read as a live
  // sibling holding nothing.
  if (!(await refExists(git, repoRoot, workRef))) return { ...base, ...QUIET };
  const landed =
    (await refExists(git, repoRoot, branchRef)) &&
    (await oidOf(git, repoRoot, branchRef)) === (await oidOf(git, repoRoot, workRef));
  const ahead = await countAhead(git, repoRoot, branchRef, workRef);
  const remoteRef =
    input.push === undefined ? undefined : `refs/remotes/${input.push.remote}/${input.push.branch}`;
  const pushed =
    remoteRef !== undefined &&
    (await refExists(git, repoRoot, remoteRef)) &&
    (await isAncestor(git, repoRoot, workRef, remoteRef));
  return {
    ...base,
    ahead,
    pushed,
    landed,
    ...(remoteRef === undefined ? {} : { remoteRef }),
  };
}

/** One ref's commit, or nothing. Fully qualified in, so a tag cannot answer. */
async function oidOf(git: GitExec, repoRoot: string, ref: string): Promise<string | undefined> {
  try {
    const oid = (
      await git(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
    ).trim();
    return oid.length > 0 ? oid : undefined;
  } catch {
    return undefined;
  }
}

/** `rev-list --count <branch>..<workBranch>` — 0 when either ref cannot answer. */
async function countAhead(
  git: GitExec,
  repoRoot: string,
  branchRef: string,
  workRef: string,
): Promise<number> {
  try {
    const count = Number.parseInt(
      (await git(repoRoot, ["rev-list", "--count", `${branchRef}..${workRef}`])).trim(),
      10,
    );
    return Number.isFinite(count) && count > 0 ? count : 0;
  } catch {
    return 0;
  }
}
