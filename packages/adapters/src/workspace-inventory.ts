// The workspace inventory (workspace-settings D6): what Rennet has actually placed on
// disk for ONE repository, read from git, the pull-request index and the sessions bound
// there — and the non-forcing removal of one idle row.
//
// Nothing here is persisted or cached. The card asks, git answers, and the answer is the
// truth at that instant; a stale row cannot outlive the read that produced it.
//
// The repository is named by its ROOT, never by a project id. A workspace project maps
// many repositories onto one identity and that mapping is not invertible, so a project id
// cannot say which repository's worktrees these are (CLAUDE.md, 2026-08-28). Every session
// match below is a POSITIVE one — a bound root that names a directory git itself listed as
// a worktree of THIS repository — so a session of a sibling repository can never colour a
// row here, and a session that records nothing is simply absent rather than assumed.
//
// Every KIND is decided positively too. `own-checkout` is the repository root this list was
// asked for — the reviewer's own checkout by definition — not "whatever was left over":
// deciding it by exclusion would relabel every Rennet worktree under a root the reviewer has
// since changed as the reviewer's own checkout, and permanently refuse to remove it. And not
// git's first (main) worktree record either: a project rooted at a LINKED worktree would then
// show two rows both saying "your own checkout".

import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { detectLocus } from "@rennet/core";
import {
  WORKTREE_REFUSAL_CAP,
  WORKTREE_ROW_MARKER_CAP,
  WORKTREE_ROWS_CAP,
  WORKTREE_SESSION_IDS_CAP,
  type WorktreeKind,
  type WorktreeRemoveOutcome,
  type WorktreeRow,
} from "@rennet/protocol";
import { execa } from "execa";
import type { GitExec } from "./git-range-diff";

/** The prefix of a Rennet sibling branch (`rennet/<branch>`, workspace `own`, D4). */
export const SIBLING_BRANCH_PREFIX = "rennet/";

/** How long ONE row's size measurement may run before the cell reads unknown (D6). */
export const WORKSPACE_SIZE_BUDGET_MS = 2000;

/**
 * How long ALL of a repository's size measurements may run in one list.
 *
 * The per-row bound is D6's; this is the sum a settings read is allowed to spend on
 * them, so a repository with a hundred workspaces cannot turn one card into a
 * multi-minute wait. Rows past it carry no size — the same honest unknown the per-row
 * bound produces, never a zero.
 */
export const WORKSPACE_SIZE_TOTAL_BUDGET_MS = 10_000;

/** One record of `git worktree list --porcelain -z`, detached and bare entries included. */
export interface WorktreeRecord {
  readonly path: string;
  readonly branch?: string;
  readonly head?: string;
  readonly detached: boolean;
  readonly bare: boolean;
  /**
   * GIT'S OWN reason this registration would be dropped by `git worktree prune`, when git
   * says there is one (`prunable <reason>` in the porcelain output).
   *
   * Read from git rather than from an `existsSync` on the daemon's side, because the two
   * disagree on exactly the arrangement that matters: a Windows daemon driving a WSL
   * repository gets `/home/u/…` from the git inside the distro, and `existsSync` on that
   * string is false for a directory that is perfectly present. Git answers inside the
   * locus that owns the path.
   *
   * Absent means git did not say — either the registration is live, or the git in hand is
   * older than the annotation. Both read the same way here, and both are the safe reading:
   * the callers treat an unannotated registration as PRESENT and change nothing.
   */
  readonly prunable?: string;
}

/**
 * Parse `git worktree list --porcelain -z` into records, KEEPING the ones with no branch.
 *
 * `parseWorktrees` (worktree-discovery) answers a different question — which worktree has
 * branch X out — and drops every detached entry to do it. The inventory has to list a
 * pull-request snapshot, which is always detached, so it parses the same bytes for itself
 * rather than widening a function whose callers depend on the narrowing.
 *
 * The `-z` form is NUL-delimited (attributes by `\0`, records by `\0\0`), so a path
 * containing a newline survives intact where a line split would corrupt it.
 */
export function parseWorktreeRecords(output: string | undefined): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  let path: string | undefined;
  let branch: string | undefined;
  let head: string | undefined;
  let detached = false;
  let bare = false;
  let prunable: string | undefined;
  const flush = (): void => {
    if (path !== undefined && path.length > 0) {
      records.push({
        path,
        ...(branch === undefined ? {} : { branch }),
        ...(head === undefined ? {} : { head }),
        detached,
        bare,
        ...(prunable === undefined ? {} : { prunable }),
      });
    }
    path = undefined;
    branch = undefined;
    head = undefined;
    detached = false;
    bare = false;
    prunable = undefined;
  };
  // `?? ""` because a runner that answers with no stdout at all is a real arrangement
  // (a stubbed GitExec, a locus shim); an empty inventory is the right reading of it,
  // a `TypeError` on `.split` is not.
  for (const token of (output ?? "").split("\0")) {
    if (token.length === 0) {
      flush(); // the double-NUL record separator yields an empty token
      continue;
    }
    if (token.startsWith("worktree ")) {
      flush(); // a new record starts even without the separator
      path = token.slice("worktree ".length); // NOT trimmed: the path is exact
    } else if (token.startsWith("branch ")) {
      const ref = token.slice("branch ".length);
      branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    } else if (token.startsWith("HEAD ")) {
      head = token.slice("HEAD ".length);
    } else if (token === "detached") {
      detached = true;
    } else if (token === "bare") {
      bare = true;
    } else if (token === "prunable" || token.startsWith("prunable ")) {
      // `prunable` alone is possible; `prunable <reason>` is what git prints for a gitdir
      // whose directory has gone. Either way the flag is git's verdict, and the reason is
      // kept so a refusal can quote it rather than invent one.
      prunable = token === "prunable" ? "prunable" : token.slice("prunable ".length);
    }
  }
  flush();
  return records;
}

/** A session as the inventory reads it: where it is bound, and when it was last active. */
export interface WorkspaceSessionRef {
  readonly id: string;
  /** The workspace this session is bound to (`SessionModel.boundRoot`). */
  readonly boundRoot?: string;
  /** Set on an archived session; an archived session holds no workspace. */
  readonly archivedAt?: number;
  /** Epoch ms of this session's latest activity, when the caller knows one. */
  readonly lastActivityAt?: number;
}

export interface ListWorkspacesOptions {
  /** The resolved worktree root — everything under it is a workspace Rennet placed. */
  readonly root: string;
  /** The paths the pull-request worktree index holds (a snapshot is detached). */
  readonly prWorktreePaths?: readonly string[];
  /** Every session the store holds; archived ones are ignored. */
  readonly sessions?: readonly WorkspaceSessionRef[];
  /**
   * Re-spell a path GIT printed into the spelling the DAEMON uses for this repository.
   *
   * One live arrangement needs it (`inRepoSpelling`, PR #789): a daemon on Windows driving
   * a WSL-locus repository addresses it as `\\wsl$\Ubuntu\home\u\repo` and stores that on
   * every session's `boundRoot`, while the git it runs lives inside the distro and answers
   * `/home/u/repo`. Without this every bound workspace would silently drop out of the list,
   * because no session's root would ever match a path git named.
   *
   * It lives here as a function rather than as an imported helper because `inRepoSpelling`
   * is server-side and adapters may not import server (CLAUDE.md, package boundaries).
   */
  readonly spellPath?: (gitPath: string) => string;
  /**
   * Does this path's filesystem spell one directory two ways? Defaults to the daemon's
   * platform — `false` everywhere off Windows, and {@link windowsFoldsCase} on it, which
   * exempts a WSL UNC path because the distro behind it is case-sensitive.
   *
   * Injectable because the arrangement it decides (a Windows daemon driving a WSL
   * repository) cannot be built on the machine the tests run on, and `process.platform` is
   * not a thing a test may honestly rewrite.
   */
  readonly foldsCase?: (path: string) => boolean;
  /** The wire's row cap. Defaults to the protocol's {@link WORKTREE_ROWS_CAP}. */
  readonly maxRows?: number;
  /** Measure sizes at all. A removal re-lists for addressing only, and skips them. */
  readonly measureSizes?: boolean;
  readonly sizeBudgetMs?: number;
  readonly totalSizeBudgetMs?: number;
  /** Injected for tests; defaults to a bounded `du`. */
  readonly measureSize?: (path: string, budgetMs: number) => Promise<number | undefined>;
  /** Injected for tests; defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * A row plus the spelling GIT uses for it.
 *
 * `WorktreeRow.path` is the DAEMON's spelling — what the card shows and what a session's
 * `boundRoot` is compared against. `gitPath` is what a git command must be handed, and on
 * a Windows daemon driving a WSL repository the two differ. A removal that passed the
 * daemon's UNC spelling to `git worktree remove` inside the distro would be refused for a
 * path git does not own, so the pair travels together server-side and only the row crosses
 * the wire.
 */
export interface WorkspaceRow extends WorktreeRow {
  readonly gitPath: string;
}

export interface WorkspaceInventory {
  readonly rows: WorkspaceRow[];
  readonly truncated: boolean;
}

function resolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Whether THIS PATH names a filesystem that spells one directory two ways — asked per path,
 * never per platform.
 *
 * Folding case unconditionally would make `<root>/repo/feat/ABC-1` and
 * `<root>/repo/feat/abc-1` — two REAL worktrees on Linux, because git branch names are
 * case-sensitive — compare equal, so a removal addressed at one could be answered by the
 * other and take the wrong `rennet/*` branch with it.
 *
 * But a Windows DAEMON is not a Windows FILESYSTEM. A WSL-locus repository is addressed
 * from Windows as `\\wsl$\Ubuntu\…` / `\\wsl.localhost\Ubuntu\…` while its files live on
 * the distro's case-SENSITIVE filesystem, so folding a Windows daemon's every path collapses
 * exactly the pair above and lands the lower-case worktree's sessions on the upper-case row.
 * `detectLocus` is the same UNC prefix test the rest of Rennet routes WSL work with, so
 * there is one definition of "this path is inside a distro", not two.
 */
export function windowsFoldsCase(path: string): boolean {
  return detectLocus(path).kind !== "wsl";
}

/** Nothing folds: the POSIX default, and the shape a non-Windows daemon runs with. */
function neverFoldsCase(): boolean {
  return false;
}

/** The predicate a daemon uses when the caller names none — read at CALL time, not at load. */
function defaultFoldsCase(path: string): boolean {
  return process.platform === "win32" ? windowsFoldsCase(path) : neverFoldsCase();
}

/**
 * The UNC HEAD of a WSL path — `\\wsl$\Ubuntu`, `\\wsl.localhost\Ubuntu` — or nothing.
 *
 * Two segments and no more. The share name and the distro name are resolved by Windows,
 * which is case-INSENSITIVE about both: `\\WSL$\ubuntu\home\u\wt` and
 * `\\wsl$\Ubuntu\home\u\wt` are one directory. Everything after them lives on the distro's
 * own filesystem, which is case-SENSITIVE, so `…\feat\ABC-1` and `…\feat\abc-1` are two.
 * Folding the whole string collapses that pair (the bug `windowsFoldsCase` exists to stop);
 * folding none of it splits ONE directory into two rows whenever a project was opened
 * through a differently cased share or distro spelling. This folds exactly Windows' half.
 */
function wslUncHead(path: string): string | undefined {
  return /^\\\\wsl(?:\$|\.localhost)\\[^\\]+/i.exec(path)?.[0];
}

/**
 * The two path comparisons the inventory makes, bound to one fold predicate.
 *
 * Each side folds by ITS OWN path, because the answer is a property of where that path
 * lives. A mixed pair (a `C:\` path against a `\\wsl$\` one) names two different
 * filesystems and cannot be the same directory either way.
 */
function pathMatchers(foldsCase: (path: string) => boolean) {
  const folded = (path: string): string => {
    // The UNC head folds whatever the predicate says: it is the half of a WSL path Windows
    // resolves, and the distro path behind it stays exactly as it was spelled.
    const head = wslUncHead(path);
    if (head !== undefined) return head.toLowerCase() + path.slice(head.length);
    return foldsCase(path) ? path.toLowerCase() : path;
  };
  /** Same directory, through symlinks, and case-insensitively only where it is spelled twice. */
  const samePath = (a: string, b: string): boolean => {
    if (a === b) return true;
    const [left, right] = [resolved(a), resolved(b)];
    return folded(left) === folded(right);
  };
  /** `path` is `root` or sits under it, compared the same forgiving way. */
  const underPath = (root: string, path: string): boolean => {
    if (samePath(root, path)) return true;
    const base = folded(resolved(root));
    const candidate = folded(resolved(path));
    const prefix = base.endsWith(sep) ? base : base + sep;
    return candidate.startsWith(prefix);
  };
  return { samePath, underPath };
}

/**
 * The row's ADDRESS: an opaque digest of the workspace's resolved path.
 *
 * Never a path, and never reversible into one. A projected client is handed a repo
 * reference and a scrubbed tail for display, so it could not echo a host path back for the
 * removal to match; the digest is the same on both sides of that boundary because both
 * sides of it are the host.
 */
export function workspaceId(path: string): string {
  return createHash("sha256").update(resolved(path)).digest("hex").slice(0, 16);
}

/**
 * When git made this workspace (D6), epoch ms — or nothing.
 *
 * A LINKED worktree's `.git` is a FILE git writes once, at creation, and never rewrites,
 * so its mtime is the creation time. The MAIN checkout's `.git` is a directory whose mtime
 * advances on every commit, fetch and ref update, so it answers a different question
 * entirely; its birth time answers the right one where the filesystem records one. Where
 * neither is available the row carries no `createdAt` and the cell reads "—", because a
 * plausible wrong date is worse than an honest blank.
 */
function createdAtOf(path: string): number | undefined {
  try {
    const stats = statSync(join(path, ".git"));
    if (!stats.isDirectory()) return stats.mtimeMs;
    return stats.birthtimeMs > 0 ? stats.birthtimeMs : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A bounded `du -sk`, in bytes. Past `budgetMs` the process is killed and the answer is
 * UNKNOWN — the caller renders "—" rather than a zero it would have to defend.
 *
 * `-sk` because it is the portable spelling: BSD `du` has no `--bytes`.
 *
 * NOTE, documented rather than fixed: this runs on the DAEMON HOST, not in the
 * repository's locus. A Windows daemon measuring a WSL repository's worktree spawns
 * `du` on Windows, where there is none, so every size on that card reads "—". Routing it
 * through `locusCommand` would fix it and belongs with the card work; an unknown size is
 * the honest cell for a measurement that did not happen, so nothing here lies meanwhile.
 */
export async function measureWorkspaceSize(
  path: string,
  budgetMs: number,
): Promise<number | undefined> {
  try {
    const result = await execa("du", ["-sk", path], { timeout: budgetMs, reject: true });
    const kilobytes = Number.parseInt(result.stdout.trim().split(/\s+/)[0] ?? "", 10);
    return Number.isFinite(kilobytes) ? kilobytes * 1024 : undefined;
  } catch {
    return undefined;
  }
}

/** Does `ref` resolve in this repository? Callers pass a FULLY QUALIFIED ref. */
export async function refExists(git: GitExec, repoRoot: string, ref: string): Promise<boolean> {
  try {
    await git(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * EVERY remote-tracking ref of `branch`, fully qualified: `refs/remotes/<remote>/<branch>`
 * for every remote this repository has one under.
 *
 * This replaced `<branch>@{upstream}`, which was the review finding W4: `@{upstream}` reads
 * the CONFIGURED upstream (`branch.<name>.merge`), and Rennet's own push sets no upstream —
 * `submitForgePullRequest` pushes an explicit refspec with no `-u`, deliberately, because
 * writing branch config into the reviewer's repository is not this action's business. So the
 * configured upstream was absent on exactly the repositories this question is asked about,
 * `siblingIsCollectable` answered false forever, and the "pushed then archived" scenario only
 * passed because its test had manufactured a `-u` push of its own.
 *
 * What the push DOES update is the remote-tracking ref for the remote it pushed to, which is
 * a fact on disk rather than a configuration, so that is what is read. The caller who KNOWS
 * the remote (the session recorded it at the push) names it and only it is consulted; the
 * sweep, which has no session to ask, consults every remote's.
 *
 * A remote whose NAME contains a slash is not matched — git allows it and nothing Rennet
 * writes creates one, and the alternative is a suffix match that cannot tell
 * `refs/remotes/origin/feat/x` from `refs/remotes/a/b/feat/x`.
 */
async function remoteTrackingRefs(
  git: GitExec,
  repoRoot: string,
  branch: string,
): Promise<string[]> {
  const listed = await git(repoRoot, ["for-each-ref", "--format=%(refname)", "refs/remotes/"], {
    reject: false,
  }).catch(() => "");
  const prefix = "refs/remotes/";
  return listed
    .split("\n")
    .map((line) => line.trim())
    .filter((ref) => {
      if (!ref.startsWith(prefix)) return false;
      const rest = ref.slice(prefix.length);
      const slash = rest.indexOf("/");
      return slash > 0 && rest.slice(slash + 1) === branch;
    });
}

/**
 * Is `ancestor` reachable from `descendant`? (`merge-base --is-ancestor`'s exit code.)
 *
 * Exported because the SIBLING BIND asks the same question with the same refs discipline —
 * both arguments FULLY QUALIFIED, so a tag of the branch's name cannot answer for it — and
 * a second spelling of this call is exactly how the two would drift apart.
 */
export async function isAncestor(
  git: GitExec,
  repoRoot: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await git(repoRoot, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

/** Where a session's work branch was actually pushed (workspace-settings D4/D5). */
export interface SiblingPushDestination {
  /** The remote the push named — `origin`, or whatever `resolveForgeRemote` answered. */
  readonly remote: string;
}

/**
 * D5's rule, asked of git: a sibling is collected only when its tip is an ancestor of the
 * local branch OR of one of that branch's remote-tracking refs (the push under `own` makes
 * the latter true). Neither ⇒ the sibling holds work the branch does not, its branch is
 * kept, and the row says how far ahead it is instead.
 *
 * `push` names the remote the session RECORDED at its push, and when it is given only that
 * remote's tracking ref is consulted — the push destination is a fact the session holds and
 * a repository with several remotes should not be able to answer for a push that went
 * somewhere else. Without it (the sweep, which has no session), every remote's is consulted,
 * because "some remote has these commits" is still reachability and refusing to look would
 * keep every swept sibling forever.
 *
 * READ FROM GIT, never from a timestamp. A recorded "pushed at" says a push once succeeded;
 * it cannot say the ref still holds the sibling's tip, and a force-push or a deleted branch
 * makes it a lie that deletes commits.
 *
 * EVERY ref is spelled `refs/heads/…` / `refs/remotes/…`. A short name is not a ref, it is
 * a search: git resolves `rennet/feat/x` through `refs/tags/` BEFORE `refs/heads/`, so a
 * tag of that name — which `git tag rennet/feat/x` on a merged commit creates by accident
 * as easily as on purpose — silently answers this question for the branch, and the caller
 * then deletes unmerged commits believing they were reachable. Reproduced against real git
 * before this was written, and pinned by a test.
 */
export async function siblingIsCollectable(
  git: GitExec,
  repoRoot: string,
  siblingBranch: string,
  branch: string,
  push?: SiblingPushDestination,
): Promise<boolean> {
  const siblingRef = `refs/heads/${siblingBranch}`;
  const branchRef = `refs/heads/${branch}`;
  if (await refExists(git, repoRoot, branchRef)) {
    if (await isAncestor(git, repoRoot, siblingRef, branchRef)) return true;
  }
  const tracking =
    push === undefined
      ? await remoteTrackingRefs(git, repoRoot, branch)
      : [`refs/remotes/${push.remote}/${branch}`];
  for (const ref of tracking) {
    if (!(await refExists(git, repoRoot, ref))) continue;
    if (await isAncestor(git, repoRoot, siblingRef, ref)) return true;
  }
  return false;
}

/** How many commits `siblingBranch` holds that `branch` does not, when both resolve. */
async function commitsAhead(
  git: GitExec,
  repoRoot: string,
  siblingBranch: string,
  branch: string,
): Promise<number | undefined> {
  try {
    const count = Number.parseInt(
      (
        await git(repoRoot, [
          "rev-list",
          "--count",
          `refs/heads/${branch}..refs/heads/${siblingBranch}`,
        ])
      ).trim(),
      10,
    );
    return Number.isFinite(count) ? count : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Why a sibling's BRANCH outlives its worktree — one sentence, and the count when there is
 * one. Asked of git, in the one vocabulary both the row's marker and the removal's note use,
 * so the card's "this keeps `rennet/feat/x`" and the outcome's "kept: …" cannot drift apart.
 *
 * The branch-is-gone arm is the reason this exists as a marker at all: there is no count to
 * report, so a row that carried only `aheadOf` said nothing and read as collectable.
 */
async function siblingKeptReason(
  git: GitExec,
  repoRoot: string,
  siblingRef: string,
  branch: string,
): Promise<{ reason: string; commits?: number }> {
  if (!(await refExists(git, repoRoot, `refs/heads/${branch}`))) {
    return { reason: `${branch} no longer exists` };
  }
  const commits = await commitsAhead(git, repoRoot, siblingRef, branch);
  if (commits !== undefined && commits > 0) {
    return {
      reason: `ahead of ${branch} by ${commits} commit${commits === 1 ? "" : "s"}`,
      commits,
    };
  }
  return { reason: `it holds commits ${branch} does not` };
}

/** The order the card reads in: the reviewer's own checkout, then Rennet's, then by path. */
const KIND_ORDER: Record<WorktreeKind, number> = {
  "own-checkout": 0,
  branch: 1,
  sibling: 2,
  "pull-request": 3,
};

/**
 * Every workspace Rennet knows for this repository (D6).
 *
 * The candidates are exactly what `git worktree list` reports for `repoRoot`, filtered to
 * the three things Rennet has a claim on: a path under the resolved worktree root, a path
 * the pull-request index holds, and a path a LIVE session records as its bound root —
 * which is the only way the reviewer's own checkout enters the list, and the reason it
 * leaves again when that session is archived.
 *
 * A worktree the reviewer made and nothing is bound to is NOT listed: Rennet did not place
 * it and has nothing to say about it.
 *
 * A git failure THROWS. `git worktree list` failing means "not a repository", "git is not
 * installed", or a locus that could not be reached, and every one of those is a different
 * thing from "this repository has no workspaces" — which is exactly what an empty list
 * would tell the reviewer, under a card that reads "Nothing yet".
 */
export async function listWorkspaces(
  git: GitExec,
  repoRoot: string,
  options: ListWorkspacesOptions,
): Promise<WorkspaceInventory> {
  const listed = await git(repoRoot, ["worktree", "list", "--porcelain", "-z"]);
  const spell = options.spellPath ?? ((gitPath: string) => gitPath);
  const { samePath, underPath } = pathMatchers(options.foldsCase ?? defaultFoldsCase);
  const records = parseWorktreeRecords(listed)
    .filter((record) => !record.bare)
    .map((record) => ({ ...record, gitPath: record.path, path: spell(record.path) }));
  const prPaths = options.prWorktreePaths ?? [];
  const sessions = (options.sessions ?? []).filter(
    (session) => session.archivedAt === undefined && session.boundRoot !== undefined,
  );

  const candidates = records.filter(
    (record) =>
      underPath(options.root, record.path) ||
      prPaths.some((prPath) => samePath(prPath, record.path)) ||
      sessions.some((session) => samePath(session.boundRoot as string, record.path)),
  );

  const rows: WorkspaceRow[] = [];
  for (const record of candidates) {
    const bound = sessions.filter((session) => samePath(session.boundRoot as string, record.path));
    const activity = bound
      .map((session) => session.lastActivityAt)
      .filter((value): value is number => value !== undefined);
    // POSITIVE discrimination, in this order: the repository root this list was asked for,
    // then the pull-request index, then the ref's own shape. Nothing is `own-checkout`
    // merely because the other three did not claim it — a Rennet worktree under a root the
    // reviewer has since changed is still a Rennet worktree, and still removable.
    //
    // `repoRoot` and ONLY `repoRoot`: git's first record is the repository's main worktree,
    // which is a different question. When the project is rooted at a linked worktree the
    // two differ, and honouring both produced two rows both reading "your own checkout" —
    // one of them a directory the reviewer never opened. Git's main worktree is then a
    // `branch` row, listed at all only when a session is bound to it, and unremovable for
    // that reason rather than by label.
    const kind: WorktreeKind = samePath(repoRoot, record.path)
      ? "own-checkout"
      : prPaths.some((prPath) => samePath(prPath, record.path))
        ? "pull-request"
        : record.branch?.startsWith(SIBLING_BRANCH_PREFIX) === true
          ? "sibling"
          : "branch";
    // A sibling D5 will not collect keeps its BRANCH when its worktree is removed, and the
    // row carries the count that says why. Asked per sibling row, never assumed from the
    // count alone: a sibling can be ahead of the local branch and still fully merged into
    // that branch's remote-tracking ref, which the push under `own` is exactly what makes true.
    //
    // `keepsBranch` rides beside it and is the honest half for the case `aheadOf` cannot
    // express: when the reviewed branch has been DELETED there is no count, so a row
    // carrying only `aheadOf` looked exactly like a collectable sibling while the removal
    // quietly kept `rennet/<branch>`. The marker says what the removal will do.
    let aheadOf: WorktreeRow["aheadOf"];
    let keepsBranch: string | undefined;
    if (kind === "sibling" && record.branch !== undefined) {
      const branch = record.branch.slice(SIBLING_BRANCH_PREFIX.length);
      if (!(await siblingIsCollectable(git, repoRoot, record.branch, branch))) {
        const kept = await siblingKeptReason(git, repoRoot, record.branch, branch);
        keepsBranch = capText(kept.reason, WORKTREE_ROW_MARKER_CAP);
        if (kept.commits !== undefined && kept.commits > 0) {
          aheadOf = { branch, commits: kept.commits };
        }
      }
    }
    const createdAt = createdAtOf(record.path);
    const lastUsedAt = activity.length > 0 ? Math.max(...activity) : undefined;
    const sessionIds = bound.map((session) => session.id);
    rows.push({
      id: workspaceId(record.path),
      path: record.path,
      gitPath: record.gitPath,
      kind,
      ...(record.branch !== undefined
        ? { ref: record.branch }
        : record.head !== undefined
          ? { ref: record.head }
          : {}),
      sessionIds: sessionIds.slice(0, WORKTREE_SESSION_IDS_CAP),
      ...(sessionIds.length > WORKTREE_SESSION_IDS_CAP ? { sessionsTruncated: true } : {}),
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(lastUsedAt === undefined ? {} : { lastUsedAt }),
      ...(aheadOf === undefined ? {} : { aheadOf }),
      ...(keepsBranch === undefined ? {} : { keepsBranch }),
      // An ahead sibling IS removable: its worktree goes and its branch stays, so the
      // commits remain on a ref the reviewer can see. Only the main checkout and a
      // workspace someone is working in cannot be addressed at all.
      removable: kind !== "own-checkout" && bound.length === 0,
    });
  }

  rows.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  const maxRows = options.maxRows ?? WORKTREE_ROWS_CAP;
  const truncated = rows.length > maxRows;
  const kept = truncated ? rows.slice(0, maxRows) : rows;

  if (options.measureSizes === false) return { rows: kept, truncated };
  const now = options.now ?? Date.now;
  const measure = options.measureSize ?? measureWorkspaceSize;
  const perRow = options.sizeBudgetMs ?? WORKSPACE_SIZE_BUDGET_MS;
  const total = options.totalSizeBudgetMs ?? WORKSPACE_SIZE_TOTAL_BUDGET_MS;
  const startedAt = now();
  const sized: WorkspaceRow[] = [];
  for (const row of kept) {
    const remaining = total - (now() - startedAt);
    if (remaining <= 0) {
      sized.push(row); // past the total bound: unknown, never a zero
      continue;
    }
    const sizeBytes = await measure(row.path, Math.min(perRow, remaining));
    sized.push(sizeBytes === undefined ? row : { ...row, sizeBytes });
  }
  return { rows: sized, truncated };
}

/** A declared byte bound with an honest truncation marker (CLAUDE.md, byte discipline). */
function capText(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}… (truncated)` : text;
}

/** Git's own words for a failure, capped with an honest marker (byte discipline). */
function refusalText(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const message =
    typeof stderr === "string" && stderr.trim().length > 0
      ? stderr.trim()
      : error instanceof Error
        ? error.message
        : String(error);
  return capText(message, WORKTREE_REFUSAL_CAP);
}

/** Who is working here, named — a fact about the row, not a scolding. */
function boundReason(row: WorkspaceRow): string {
  const [first] = row.sessionIds;
  return row.sessionIds.length === 1 && first !== undefined
    ? `bound to session ${first}`
    : `bound to ${row.sessionIds.length} sessions`;
}

/**
 * Why a sibling branch outlived its worktree, in the outcome's own words — from the SAME
 * `siblingKeptReason` the row's `keepsBranch` marker is built from, so the card's warning
 * and the outcome that follows it are the same sentence about the same repository.
 *
 * They can still differ in TWO ways, and both are honest rather than a drift: the row was
 * read earlier, so a push or a commit since then changes git's answer; and the row's marker
 * is capped at {@link WORKTREE_ROW_MARKER_CAP} while this one rides the removal's larger
 * {@link WORKTREE_REFUSAL_CAP}, so a very long branch name is truncated on the row and
 * whole here. Only the wording is shared; the cap is each surface's own.
 */
async function keptSiblingNote(
  git: GitExec,
  repoRoot: string,
  siblingRef: string,
  branch: string,
): Promise<string> {
  const { reason } = await siblingKeptReason(git, repoRoot, siblingRef, branch);
  return capText(`${siblingRef} kept: ${reason}`, WORKTREE_REFUSAL_CAP);
}

export interface RemoveWorkspaceInput {
  /** The row's opaque id, as the list reported it. */
  readonly id: string;
  /** A FRESH inventory of the same repository — what the removal is addressed against. */
  readonly rows: readonly WorkspaceRow[];
}

/**
 * Remove one workspace: `git worktree remove` WITHOUT `--force`, so git's own refusal is
 * the only thing that stops it and uncommitted work is never swept. The refusal comes
 * back verbatim; the directory is left exactly as git left it.
 *
 * The row is addressed out of a fresh inventory rather than trusted from the caller, which
 * is what makes "the reviewer's own checkout cannot be removed" a fact about the repository
 * rather than a client-side omission. An id that names no workspace of this repository, the
 * repository's main checkout, and a workspace a live session is bound to answer
 * `not-removable`, and NOTHING runs.
 *
 * An ahead sibling is NOT one of those. D5 gates the deletion of a BRANCH, and removing a
 * worktree loses nothing: the commits stay on `rennet/<branch>`, a ref the reviewer can
 * see and check out. Refusing the removal would be Rennet inventing a "no" where git would
 * have said yes — a gate (Rule Zero). So the worktree goes, the branch stays, and the
 * outcome's note says which happened. The automatic archive/sweep path (D5) is the one
 * that keeps both, because nobody asked it for anything.
 *
 * No confirmation, no ceremony: one call does it (Rule Zero).
 */
export async function removeWorkspace(
  git: GitExec,
  repoRoot: string,
  input: RemoveWorkspaceInput,
): Promise<WorktreeRemoveOutcome> {
  const row = input.rows.find((candidate) => candidate.id === input.id);
  if (row === undefined) {
    return {
      status: "not-removable",
      id: input.id,
      reason: "not a workspace Rennet knows for this repository",
    };
  }
  if (row.kind === "own-checkout") {
    return { status: "not-removable", id: row.id, path: row.path, reason: "your own checkout" };
  }
  if (row.sessionIds.length > 0) {
    return { status: "not-removable", id: row.id, path: row.path, reason: boundReason(row) };
  }
  try {
    // GIT's spelling of the path, not the daemon's: inside a WSL distro the UNC form
    // names nothing git owns.
    await git(repoRoot, ["worktree", "remove", row.gitPath], { reject: true });
  } catch (error) {
    return { status: "refused", id: row.id, path: row.path, reason: refusalText(error) };
  }
  if (row.kind !== "sibling" || row.ref === undefined) {
    return { status: "removed", id: row.id, path: row.path };
  }
  const branch = row.ref.slice(SIBLING_BRANCH_PREFIX.length);
  if (!(await refExists(git, repoRoot, `refs/heads/${row.ref}`))) {
    return { status: "removed", id: row.id, path: row.path }; // no branch left to decide about
  }
  // The sibling's branch goes with its worktree, but only after D5's rule is asked AGAIN
  // at the moment of deletion — the list that decided the row was a read, and a push or a
  // commit could have landed since. `-d` first; `-D` only once ancestry is proven, because
  // `-d` measures merged-into-HEAD (whatever the clone happens to have out) while D5
  // measures merged-into-the-branch-or-its-remote, which is the stronger question and the
  // one that decides whether a commit can be lost. Nothing is forced past a "no".
  //
  // `git branch` is given the SHORT name deliberately: it deletes branches and only
  // branches, so the tag that can shadow `rennet/feat/x` in a revision walk cannot be
  // deleted by it, and git rejects a `refs/heads/…` argument here outright.
  if (!(await siblingIsCollectable(git, repoRoot, row.ref, branch))) {
    return {
      status: "removed",
      id: row.id,
      path: row.path,
      siblingBranchDeleted: false,
      note: await keptSiblingNote(git, repoRoot, row.ref, branch),
    };
  }
  try {
    await git(repoRoot, ["branch", "-d", row.ref], { reject: true });
    return { status: "removed", id: row.id, path: row.path, siblingBranchDeleted: true };
  } catch {
    try {
      await git(repoRoot, ["branch", "-D", row.ref], { reject: true });
      return { status: "removed", id: row.id, path: row.path, siblingBranchDeleted: true };
    } catch (error) {
      return {
        status: "removed",
        id: row.id,
        path: row.path,
        siblingBranchDeleted: false,
        note: `${row.ref} kept: ${refusalText(error)}`,
      };
    }
  }
}
