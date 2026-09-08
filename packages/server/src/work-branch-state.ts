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
// over a branch that had caught up — the "lie in the UI" family. A handful of ref reads
// answer all of it, they cost nothing, and they cannot be stale.
//
// Every ref is FULLY QUALIFIED. `rev-parse rennet/feat/x` resolves `refs/tags/` before
// `refs/heads/`, so a tag of that name would answer the ahead/pushed/landed questions for a
// branch it has nothing to do with — the same trap `siblingIsCollectable` and the land
// action each spell out, for the same reason.

import { isAncestor, refExists } from "@rennet/adapters";

/** `git(cwd, args)` — the locus-aware exec the daemon builds per repository. */
type GitExec = (cwd: string, args: string[], options?: { reject?: boolean }) => Promise<string>;

/**
 * What the surface renders beside the session's branch. Every field a ref question.
 *
 * TWO COUNTS, BECAUSE THEY ANSWER TWO QUESTIONS AND THEY DIFFER. There was one, `ahead`,
 * and the strip spent it on both sentences: it counted `<branch>..<workBranch>` and then
 * rendered "`feat/x` is behind `origin/feat/x` by N" with it. Those are the same number
 * only while the remote holds exactly the sibling's commits and nothing else — and the
 * remote is the one ref anybody else can move. A teammate's push, a second session's
 * submission, or a landing that advanced the remote past the sibling each make the local
 * branch further behind than the sibling is ahead, and the strip said the sibling's number
 * under the remote's sentence. So each sentence now reads the range it is actually about.
 */
export interface WorkBranchState {
  /** The reviewed branch, when the session knows one. */
  readonly branch?: string;
  /** The branch the work commits on. Absent, or equal to `branch`, ⇒ nothing to say. */
  readonly workBranch?: string;
  /**
   * Commits the WORK BRANCH holds that the reviewed branch does not —
   * `refs/heads/<branch>..refs/heads/<workBranch>`. This is what "the round's commits are
   * on `rennet/feat/x`, `feat/x` has not moved" is about, and it says nothing about a
   * remote.
   */
  readonly aheadOfBranch: number;
  /**
   * Commits the recorded push destination's ref holds that the REVIEWED BRANCH does not —
   * `refs/heads/<branch>..refs/remotes/<remote>/<branch>`. This is the only honest number
   * for "`feat/x` is behind `origin/feat/x` by N", and it is 0 with no recorded push,
   * because nothing has been sent anywhere to be behind.
   */
  readonly behindRemote: number;
  /** The work branch's tip is reachable from the recorded push destination's ref. */
  readonly pushed: boolean;
  /** The reviewed branch already CONTAINS the work branch's tip. */
  readonly landed: boolean;
  /** The remote-tracking ref `pushed` was decided against — named, never called "upstream". */
  readonly remoteRef?: string;
}

/** Nothing to say: no work branch, no session, or the work is on the reviewed branch. */
const QUIET = { aheadOfBranch: 0, behindRemote: 0, pushed: false, landed: false } as const;

/**
 * The same silence, for a caller that has no repository to ask — a session that is gone,
 * or one whose repository root cannot be resolved. Exported so the daemon's binding cannot
 * spell its own version of "nothing to say" and drift from this one.
 */
export const QUIET_WORK_BRANCH_STATE: WorkBranchState = QUIET;

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
  // LANDED IS ANCESTRY, NOT EQUAL TIPS. It was `rev-parse <branch> === rev-parse
  // <workBranch>`, which stops holding the instant the reviewer does anything AFTER the
  // fast-forward — pull one commit, commit one line — and the strip went back to saying
  // "the round's commits are on `rennet/feat/x`; `feat/x` has not moved" over a branch that
  // had already carried them. What the sentence is really about is whether the branch
  // CONTAINS the work, and `merge-base --is-ancestor` answers exactly that (equal tips
  // included, since a commit is its own ancestor).
  const landed =
    (await refExists(git, repoRoot, branchRef)) &&
    (await isAncestor(git, repoRoot, workRef, branchRef));
  const aheadOfBranch = await countRange(git, repoRoot, branchRef, workRef);
  const remoteRef =
    input.push === undefined ? undefined : `refs/remotes/${input.push.remote}/${input.push.branch}`;
  let pushed = false;
  // The REMOTE's own range, never the sibling's: how far the reviewed branch is behind the
  // ref the push actually updated. Anyone can move that ref, so it is asked of that ref.
  let behindRemote = 0;
  if (remoteRef !== undefined && (await refExists(git, repoRoot, remoteRef))) {
    pushed = await isAncestor(git, repoRoot, workRef, remoteRef);
    behindRemote = await countRange(git, repoRoot, branchRef, remoteRef);
  }
  return {
    ...base,
    aheadOfBranch,
    behindRemote,
    pushed,
    landed,
    ...(remoteRef === undefined ? {} : { remoteRef }),
  };
}

/** `rev-list --count <from>..<to>` — commits `to` holds that `from` does not, 0 when
 *  either ref cannot answer. Both refs fully qualified in, so a tag cannot stand in. */
async function countRange(
  git: GitExec,
  repoRoot: string,
  fromRef: string,
  toRef: string,
): Promise<number> {
  try {
    const count = Number.parseInt(
      (await git(repoRoot, ["rev-list", "--count", `${fromRef}..${toRef}`])).trim(),
      10,
    );
    return Number.isFinite(count) && count > 0 ? count : 0;
  } catch {
    return 0;
  }
}
