import type { LocalWork, Project, ProjectDetail } from "@rennet/protocol";
import type { GitExec } from "./git-range-diff";
import { defaultProjectDiscoveryDeps, discoverProject } from "./project-discovery";
import { parseRemoteIdentity } from "./worktree-discovery";

/**
 * The LIVE local-work half of the project-detail substrate (issue #37, wave B1).
 *
 * The unified smart-list surface reaches MAIN through the real `project.detail`
 * command; the renderer derives every row/filter/sort from the raw shape
 * `ProjectDetail = { viewer, locals, prs, truncated }`. This module fills the LOCAL
 * half of that shape from real git — detected worktrees + local branches, with
 * `dirty` / `ahead` / `behind` / recency computed from the repo — replacing the
 * `projectDetailFixture()` local set. It issues ONLY read verbs (`worktree list`,
 * `for-each-ref`, `status --porcelain`, `rev-list`, `config`) and never mutates the
 * index or working tree.
 *
 * SCOPE (B1): local git only. `prs` is returned empty and `truncated` false; the
 * live GitHub PR set (B2), CI + dedupe fidelity (B3), and live clean-up (B4) extend
 * this same module behind the unchanged command boundary.
 *
 * ── Contract notes the sibling waves depend on ───────────────────────────────
 *  • `repository` identity is `owner/name` (from the origin remote), falling back to
 *    the repo directory basename when there is no forge remote. B2 MUST emit the
 *    SAME `owner/name` identity for each PullRequest so the renderer's composite
 *    `(repository, branch)` dedupe folds a local branch into its PR row. This is an
 *    EXACT string match (see `smart-list.ts` `compositeKey`), so the two halves must
 *    agree byte-for-byte.
 *  • Ownership: local work is the viewer's by definition ("you edit what you own"),
 *    so every LocalWork.author is set to the viewer login — matching the shipped
 *    fixture semantics and `smart-list.ts` (`local.author === viewer` ⇒ mine). The
 *    viewer login is the local git identity here (no GitHub call in B1); B2 replaces
 *    it with the real GitHub login from `resolveGitHubAuth`, and because author is
 *    pinned to the viewer, that swap keeps local work reading as "mine".
 *  • `stage` is "captured" for every live local: without rennet's own review/PR
 *    tracking there is no local signal for "reviewed"/"prd" yet. Real stage lands
 *    when the review state is consulted (a follow-up).
 */

/** The injected effects the source needs. Everything is a read; nothing mutates. */
export interface ProjectDetailSourceDeps {
  /** The injected git runner (no shell). */
  git: GitExec;
  /**
   * The repo working-tree roots for a project. A `repo` project is a single root; a
   * `workspace` fans out to its discovered repos. Injected so the enumeration is
   * testable without a real workspace on disk.
   */
  resolveRepoRoots(project: Project): Promise<readonly string[]>;
}

/** Trim git stdout and read the first non-empty line. */
function firstLine(output: string): string {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
}

/** The `owner/name` identity of a repo root, or its basename when there is no forge remote. */
async function repositoryIdentity(git: GitExec, root: string): Promise<string> {
  const url = firstLine(await git(root, ["remote", "get-url", "origin"], { reject: false }));
  const identity = url ? parseRemoteIdentity(url) : null;
  if (identity) return `${identity.owner}/${identity.name}`;
  // basename fallback: the last path segment, resilient to a trailing slash.
  const segments = root.split("/").filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? root;
}

/** A local branch's last-commit time (unix seconds) and whether it exists locally. */
type BranchActivity = Map<string, number>;

/** Read every local branch's committer time (`for-each-ref`), keyed by short name. */
async function readBranchActivity(git: GitExec, root: string): Promise<BranchActivity> {
  const out = await git(
    root,
    ["for-each-ref", "--format=%(refname:short)%09%(committerdate:unix)", "refs/heads"],
    { reject: false },
  );
  const activity: BranchActivity = new Map();
  for (const line of out.split("\n")) {
    if (line.trim().length === 0) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const name = line.slice(0, tab);
    const unix = Number.parseInt(line.slice(tab + 1).trim(), 10);
    if (name.length > 0 && Number.isFinite(unix)) activity.set(name, unix);
  }
  return activity;
}

/** A worktree checked out on a branch, parsed from `git worktree list --porcelain`. */
interface ParsedWorktree {
  path: string;
  branch: string;
}

/** Parse `git worktree list --porcelain` into (path, branch) pairs; detached skipped. */
function parseWorktrees(output: string): ParsedWorktree[] {
  const worktrees: ParsedWorktree[] = [];
  let path: string | undefined;
  let branch: string | undefined;
  const flush = (): void => {
    if (path && branch) worktrees.push({ path, branch });
    path = undefined;
    branch = undefined;
  };
  for (const raw of output.split("\n")) {
    const line = raw.trimEnd();
    if (line.length === 0) {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      flush(); // a new record starts even without a blank separator
      path = line.slice("worktree ".length);
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length);
      branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    }
    // `detached`, `bare`, `HEAD <sha>` carry no branch → the record flushes without one.
  }
  flush();
  return worktrees;
}

/** Commits behind/ahead of `primary` for `branch` (`rev-list --left-right --count`). */
async function aheadBehind(
  git: GitExec,
  root: string,
  primary: string,
  branch: string,
): Promise<{ ahead: number; behind: number }> {
  const out = await git(root, ["rev-list", "--left-right", "--count", `${primary}...${branch}`], {
    reject: false,
  });
  const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(out);
  if (!match) return { ahead: 0, behind: 0 };
  // `primary...branch` with --left-right: left = in primary not branch = behind;
  // right = in branch not primary = ahead.
  return {
    behind: Number.parseInt(match[1] ?? "0", 10),
    ahead: Number.parseInt(match[2] ?? "0", 10),
  };
}

/** Whether the worktree at `path` has uncommitted changes (`status --porcelain`). */
async function isDirty(git: GitExec, path: string): Promise<boolean> {
  const out = await git(path, ["status", "--porcelain"], { reject: false });
  return out.split("\n").some((line) => line.trim().length > 0);
}

/** A unix-seconds instant as a UTC ISO string (millis + `Z`), safe for `z.iso.datetime()`. */
function isoFromUnix(unix: number): string {
  return new Date(unix * 1000).toISOString();
}

/** Enumerate one repo root's local work: its worktrees + branches, minus the primary. */
async function loadRepoLocalWork(
  git: GitExec,
  root: string,
  primaryBranch: string,
  viewer: string,
): Promise<LocalWork[]> {
  const repository = await repositoryIdentity(git, root);
  const activity = await readBranchActivity(git, root);
  const worktreesRaw = await git(root, ["worktree", "list", "--porcelain"], { reject: false });
  const worktrees = parseWorktrees(worktreesRaw);

  // Key on the composite (repository, branch) so a checked-out worktree and its own
  // ref never double-count, while a branch name reused across repos stays distinct.
  const byKey = new Map<string, LocalWork>();
  const keyOf = (branch: string): string => `${repository}\n${branch}`;

  const activityAt = async (branch: string): Promise<string> => {
    const unix = activity.get(branch);
    if (unix !== undefined) return isoFromUnix(unix);
    // A worktree branch missing from the ref scan is unexpected; read it directly.
    const out = firstLine(
      await git(root, ["log", "-1", "--format=%ct", branch], { reject: false }),
    );
    const parsed = Number.parseInt(out, 10);
    return isoFromUnix(Number.isFinite(parsed) ? parsed : 0);
  };

  // Worktrees first — they carry a real `dirty` signal and the clean-up target id.
  for (const worktree of worktrees) {
    if (worktree.branch === primaryBranch) continue;
    const key = keyOf(worktree.branch);
    if (byKey.has(key)) continue;
    const [{ ahead, behind }, dirty, lastActivityAt] = await Promise.all([
      aheadBehind(git, root, primaryBranch, worktree.branch),
      isDirty(git, worktree.path),
      activityAt(worktree.branch),
    ]);
    byKey.set(key, {
      id: worktree.path, // the clean-up target: `git worktree remove <path>`
      repository,
      branch: worktree.branch,
      author: viewer,
      dirty,
      ahead,
      behind,
      stage: "captured",
      lastActivityAt,
    });
  }

  // Then any local branch not already represented by a worktree above.
  for (const branch of activity.keys()) {
    if (branch === primaryBranch) continue;
    const key = keyOf(branch);
    if (byKey.has(key)) continue;
    const { ahead, behind } = await aheadBehind(git, root, primaryBranch, branch);
    byKey.set(key, {
      id: `${repository}#${branch}`, // no worktree on disk → a branch-delete target
      repository,
      branch,
      author: viewer,
      dirty: false,
      ahead,
      behind,
      stage: "captured",
      lastActivityAt: isoFromUnix(activity.get(branch) ?? 0),
    });
  }

  return [...byKey.values()];
}

/** The viewer login from local git identity (`user.name`, else `user.email`, else `you`). */
async function resolveViewerLogin(git: GitExec, roots: readonly string[]): Promise<string> {
  const root = roots[0];
  if (!root) return "you";
  const name = firstLine(await git(root, ["config", "user.name"], { reject: false }));
  if (name.length > 0) return name;
  const email = firstLine(await git(root, ["config", "user.email"], { reject: false }));
  if (email.length > 0) return email;
  return "you";
}

/**
 * Build the live `ProjectDetail` for a project from real git. B1 fills the local
 * half; `prs` is empty and `truncated` false until B2/B3 extend this module.
 */
export async function loadProjectDetail(
  deps: ProjectDetailSourceDeps,
  project: Project,
): Promise<ProjectDetail> {
  const roots = await deps.resolveRepoRoots(project);
  const viewer = await resolveViewerLogin(deps.git, roots);
  const perRepo = await Promise.all(
    roots.map((root) => loadRepoLocalWork(deps.git, root, project.primaryBranch, viewer)),
  );
  return {
    viewer: { login: viewer },
    locals: perRepo.flat(),
    prs: [],
    truncated: false,
  };
}

/**
 * The real source effects. `resolveRepoRoots` maps a project onto its repo roots: a
 * `repo` project is its own open path; a `workspace` fans out via read-only
 * discovery to every repo it contains.
 */
export function defaultProjectDetailSourceDeps(git: GitExec): ProjectDetailSourceDeps {
  return {
    git,
    async resolveRepoRoots(project: Project): Promise<readonly string[]> {
      if (project.kind === "repo") return [project.openPath || project.path];
      const result = await discoverProject(
        defaultProjectDiscoveryDeps(git),
        project.path,
        "workspace",
      );
      return result.repos.map((repo) => repo.path);
    },
  };
}
