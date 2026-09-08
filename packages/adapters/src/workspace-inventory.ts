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

import { realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import {
  WORKTREE_REFUSAL_CAP,
  WORKTREE_ROWS_CAP,
  type WorktreeInventory,
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
export function parseWorktreeRecords(output: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  let path: string | undefined;
  let branch: string | undefined;
  let head: string | undefined;
  let detached = false;
  let bare = false;
  const flush = (): void => {
    if (path !== undefined && path.length > 0) {
      records.push({
        path,
        ...(branch === undefined ? {} : { branch }),
        ...(head === undefined ? {} : { head }),
        detached,
        bare,
      });
    }
    path = undefined;
    branch = undefined;
    head = undefined;
    detached = false;
    bare = false;
  };
  for (const token of output.split("\0")) {
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

function resolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Same directory, through symlinks, and case-insensitively where Windows spells it twice. */
function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  const [left, right] = [resolved(a), resolved(b)];
  return left === right || left.toLowerCase() === right.toLowerCase();
}

/** `path` is `root` or sits under it, compared the same forgiving way. */
function underPath(root: string, path: string): boolean {
  if (samePath(root, path)) return true;
  const [base, candidate] = [resolved(root), resolved(path)];
  const prefix = base.endsWith(sep) ? base : base + sep;
  return candidate.startsWith(prefix) || candidate.toLowerCase().startsWith(prefix.toLowerCase());
}

/** The `.git` file's mtime — when git made this workspace (D6). Unreadable ⇒ unknown. */
function createdAtOf(path: string): number | undefined {
  try {
    return statSync(join(path, ".git")).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * A bounded `du -sk`, in bytes. Past `budgetMs` the process is killed and the answer is
 * UNKNOWN — the caller renders "—" rather than a zero it would have to defend.
 *
 * `-sk` because it is the portable spelling: BSD `du` has no `--bytes`. A locus whose
 * shell has no `du` at all (a WSL project addressed from Windows) simply answers unknown,
 * which is the honest cell for a measurement that did not happen.
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

/** Does `ref` resolve in this repository? */
async function refExists(git: GitExec, repoRoot: string, ref: string): Promise<boolean> {
  try {
    await git(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** The branch's remote-tracking ref, or undefined when it has no upstream. */
async function upstreamOf(
  git: GitExec,
  repoRoot: string,
  branch: string,
): Promise<string | undefined> {
  try {
    const ref = (
      await git(repoRoot, [
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        `${branch}@{upstream}`,
      ])
    ).trim();
    return ref.length > 0 ? ref : undefined;
  } catch {
    return undefined;
  }
}

/** Is `ancestor` reachable from `descendant`? (`merge-base --is-ancestor`'s exit code.) */
async function isAncestor(
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

/**
 * D5's rule, asked of git: a sibling is collected only when its tip is an ancestor of the
 * local branch OR of that branch's remote-tracking ref (the push under `own` makes the
 * latter true). Neither ⇒ the sibling holds work the branch does not, and nothing is
 * removed or deleted; the row says how far ahead it is instead.
 */
export async function siblingIsCollectable(
  git: GitExec,
  repoRoot: string,
  siblingBranch: string,
  branch: string,
): Promise<boolean> {
  if (await refExists(git, repoRoot, branch)) {
    if (await isAncestor(git, repoRoot, siblingBranch, branch)) return true;
  }
  const upstream = await upstreamOf(git, repoRoot, branch);
  if (upstream !== undefined && (await refExists(git, repoRoot, upstream))) {
    return isAncestor(git, repoRoot, siblingBranch, upstream);
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
      (await git(repoRoot, ["rev-list", "--count", `${branch}..${siblingBranch}`])).trim(),
      10,
    );
    return Number.isFinite(count) ? count : undefined;
  } catch {
    return undefined;
  }
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
 */
export async function listWorkspaces(
  git: GitExec,
  repoRoot: string,
  options: ListWorkspacesOptions,
): Promise<WorktreeInventory> {
  const listed = await git(repoRoot, ["worktree", "list", "--porcelain", "-z"], {
    reject: false,
  }).catch(() => "");
  const records = parseWorktreeRecords(listed).filter((record) => !record.bare);
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

  const rows: WorktreeRow[] = [];
  for (const record of candidates) {
    const bound = sessions.filter((session) => samePath(session.boundRoot as string, record.path));
    const activity = bound
      .map((session) => session.lastActivityAt)
      .filter((value): value is number => value !== undefined);
    const isSibling = record.branch?.startsWith(SIBLING_BRANCH_PREFIX) === true;
    const kind: WorktreeKind = prPaths.some((prPath) => samePath(prPath, record.path))
      ? "pull-request"
      : isSibling
        ? "sibling"
        : underPath(options.root, record.path)
          ? "branch"
          : "own-checkout";
    // A sibling that D5 will not collect keeps BOTH its worktree and its branch, and the
    // row carries the count that says why. Asked per sibling row, never assumed from the
    // count alone: a sibling can be ahead of the local branch and still fully merged into
    // that branch's remote-tracking ref, which the push under `own` is exactly what makes true.
    let aheadOf: WorktreeRow["aheadOf"];
    let collectable = true;
    if (kind === "sibling" && record.branch !== undefined) {
      const branch = record.branch.slice(SIBLING_BRANCH_PREFIX.length);
      collectable = await siblingIsCollectable(git, repoRoot, record.branch, branch);
      if (!collectable) {
        const commits = await commitsAhead(git, repoRoot, record.branch, branch);
        if (commits !== undefined && commits > 0) aheadOf = { branch, commits };
      }
    }
    const createdAt = createdAtOf(record.path);
    const lastUsedAt = activity.length > 0 ? Math.max(...activity) : undefined;
    rows.push({
      path: record.path,
      kind,
      ...(record.branch !== undefined
        ? { ref: record.branch }
        : record.head !== undefined
          ? { ref: record.head }
          : {}),
      sessionIds: bound.map((session) => session.id).slice(0, WORKTREE_ROWS_CAP),
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(lastUsedAt === undefined ? {} : { lastUsedAt }),
      ...(aheadOf === undefined ? {} : { aheadOf }),
      removable: kind !== "own-checkout" && bound.length === 0 && collectable,
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
  const sized: WorktreeRow[] = [];
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

/** Git's own words for a failure, capped with an honest marker (byte discipline). */
function refusalText(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const message =
    typeof stderr === "string" && stderr.trim().length > 0
      ? stderr.trim()
      : error instanceof Error
        ? error.message
        : String(error);
  return message.length > WORKTREE_REFUSAL_CAP
    ? `${message.slice(0, WORKTREE_REFUSAL_CAP)}… (truncated)`
    : message;
}

export interface RemoveWorkspaceInput {
  /** The row's path, as the list reported it. */
  readonly path: string;
  /** A FRESH inventory of the same repository — what the removal is addressed against. */
  readonly rows: readonly WorktreeRow[];
}

/**
 * Remove one workspace: `git worktree remove` WITHOUT `--force`, so git's own refusal is
 * the only thing that stops it and uncommitted work is never swept. The refusal comes
 * back verbatim; the directory is left exactly as git left it.
 *
 * The row is addressed out of a fresh inventory rather than trusted from the caller, which
 * is what makes "the reviewer's own checkout cannot be removed" a fact about the repository
 * rather than a client-side omission. A path that is not a workspace of this repository, the
 * reviewer's own checkout, a workspace a live session is bound to, and a sibling holding
 * work its branch does not, all answer `not-removable` and NOTHING runs.
 *
 * No confirmation, no ceremony: one call does it (Rule Zero).
 */
export async function removeWorkspace(
  git: GitExec,
  repoRoot: string,
  input: RemoveWorkspaceInput,
): Promise<WorktreeRemoveOutcome> {
  const row = input.rows.find((candidate) => samePath(candidate.path, input.path));
  if (row === undefined) {
    return {
      status: "not-removable",
      path: input.path,
      reason: "not a workspace Rennet knows for this repository",
    };
  }
  if (row.kind === "own-checkout") {
    return { status: "not-removable", path: row.path, reason: "your own checkout" };
  }
  if (row.sessionIds.length > 0) {
    return {
      status: "not-removable",
      path: row.path,
      reason: `a session is working here (${row.sessionIds.length})`,
    };
  }
  if (!row.removable) {
    return {
      status: "not-removable",
      path: row.path,
      reason:
        row.aheadOf === undefined
          ? `${row.ref ?? row.path} holds commits its branch does not`
          : `ahead of ${row.aheadOf.branch} by ${row.aheadOf.commits} commit${row.aheadOf.commits === 1 ? "" : "s"}`,
    };
  }
  try {
    await git(repoRoot, ["worktree", "remove", row.path], { reject: true });
  } catch (error) {
    return { status: "refused", path: row.path, reason: refusalText(error) };
  }
  if (row.kind !== "sibling" || row.ref === undefined) {
    return { status: "removed", path: row.path };
  }
  // The sibling's branch goes with its worktree, but only after D5's rule is asked AGAIN
  // at the moment of deletion — the list that decided `removable` was a read, and a push
  // or a commit could have landed since. `-d` first; `-D` only once ancestry is proven,
  // because `-d` measures merged-into-HEAD (whatever the clone happens to have out) while
  // D5 measures merged-into-the-branch-or-its-remote, which is the stronger question and
  // the one that decides whether a commit can be lost. Nothing is forced past a "no".
  const branch = row.ref.slice(SIBLING_BRANCH_PREFIX.length);
  if (!(await siblingIsCollectable(git, repoRoot, row.ref, branch))) {
    return { status: "removed", path: row.path, siblingBranchDeleted: false };
  }
  try {
    await git(repoRoot, ["branch", "-d", row.ref], { reject: true });
    return { status: "removed", path: row.path, siblingBranchDeleted: true };
  } catch {
    try {
      await git(repoRoot, ["branch", "-D", row.ref], { reject: true });
      return { status: "removed", path: row.path, siblingBranchDeleted: true };
    } catch {
      return { status: "removed", path: row.path, siblingBranchDeleted: false };
    }
  }
}
