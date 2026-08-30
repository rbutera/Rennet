import type {
  ForgeRepoIdentity,
  LocalWork,
  Project,
  ProjectDetail,
  ProjectDetailProgressEvent,
  PullRequest,
  PullRequestState,
} from "@rennet/protocol";
import { forgeRepositorySlug } from "@rennet/protocol";
import type { GitExec } from "./git-range-diff";
import { isGitHubNetworkError } from "./github-fetch";
import { defaultProjectDiscoveryDeps, discoverProject } from "./project-discovery";
import type { ProjectPrSource } from "./project-pr-source";
import { forgeForRemoteHost, parseRemoteIdentity, type RemoteIdentity } from "./worktree-discovery";

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
 * SCOPE: the local half is always real git. The remote half is live — an injected
 * `prSource` fans out over the project's forge repos and fills `prs` + `truncated`;
 * with no source wired (or GitHub auth unavailable) `prs` stays empty, `truncated`
 * false, and `authUnavailable` names the reason. CI + dedupe fidelity and live
 * clean-up extend this same module behind the unchanged command boundary.
 *
 * ── Contract notes the sibling waves depend on ───────────────────────────────
 *  • `repository` identity is `owner/name` (from the origin remote). The PR source emits
 *    the SAME `owner/name` identity for each PullRequest so the renderer's composite
 *    `(repository, branch)` dedupe folds a local branch into its PR row. This is an
 *    EXACT string match (see `smart-list.ts` `compositeKey`), so the two halves must
 *    agree byte-for-byte. When there is NO forge remote the identity falls back to the
 *    durable RepoRecord alias — `realpath(git-common-dir)` (R19) — NOT a directory-name
 *    guess: `worktree-discovery.ts`'s law forbids inferring `acme/widget` from a dir
 *    named `widget`. A local-only repo has no PR, so this only ever keys local dedupe.
 *  • Ownership: local work is the viewer's by definition ("you edit what you own"),
 *    so every LocalWork.author is set to the viewer login — matching the shipped
 *    fixture semantics and `smart-list.ts` (`local.author === viewer` ⇒ mine). The
 *    viewer login is the local git identity when no PR source answers; with one wired
 *    it is the real GitHub login from `prSource.resolveViewer`, and because author is
 *    pinned to the viewer, that resolution keeps local work reading as "mine".
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
  /**
   * The live remote-PR half. Absent → `prs` stays empty and the surface is the
   * local-only list (also the honest degrade when GitHub auth is unavailable: no
   * token ⇒ no source is wired here, never a failed fetch rendered as "zero PRs").
   */
  forgeRegistry?: ProjectForgeRegistry;
}

/** The project-detail forges available in this server process. GitHub is the sole entry today. */
export interface ProjectForgeRegistry {
  sourceFor(repository: ForgeRepoIdentity): ProjectPrSource | undefined;
}

/** Trim git stdout and read the first non-empty line. */
function firstLine(output: string): string {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
}

/**
 * The repo's stable identity: `owner/name` from the origin remote, else the durable
 * RepoRecord alias `realpath(git-common-dir)` (R19). NEVER the directory basename —
 * that is the path-name guess `worktree-discovery.ts` explicitly forbids.
 */
export interface RepositoryIdentity {
  repository: string;
  forgeRepository?: ForgeRepoIdentity;
}

/** Provider id for a parsed remote. Unknown hosts remain distinct and have no registered source. */
export function forgeRepositoryFromRemote(identity: RemoteIdentity): ForgeRepoIdentity {
  return {
    forge: forgeForRemoteHost(identity.host),
    owner: identity.owner,
    name: identity.name,
  };
}

export async function repositoryIdentity(git: GitExec, root: string): Promise<RepositoryIdentity> {
  const url = firstLine(await git(root, ["remote", "get-url", "origin"], { reject: false }));
  const identity = url ? parseRemoteIdentity(url) : null;
  if (identity) {
    const forgeRepository = forgeRepositoryFromRemote(identity);
    return { repository: forgeRepositorySlug(forgeRepository), forgeRepository };
  }
  // No forge remote → the durable common-dir identity, not a directory-name guess.
  const commonDir = firstLine(
    await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { reject: false }),
  );
  if (commonDir.length > 0) return { repository: commonDir };
  return { repository: root }; // last resort: not a git work tree, so no branches are emitted anyway.
}

function repositoryKey(identity: RepositoryIdentity): string {
  const forge = identity.forgeRepository;
  return forge === undefined ? identity.repository : `${forge.forge}:${forge.owner}/${forge.name}`;
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

/**
 * Parse `git worktree list --porcelain -z` into (path, branch) pairs; detached
 * skipped. The `-z` form is NUL-delimited (attributes split by `\0`, records by
 * `\0\0`), so a worktree path containing a newline or trailing whitespace survives
 * intact — a plain-`--porcelain` newline split would corrupt it.
 */
function parseWorktrees(output: string): ParsedWorktree[] {
  const worktrees: ParsedWorktree[] = [];
  let path: string | undefined;
  let branch: string | undefined;
  const flush = (): void => {
    if (path && branch) worktrees.push({ path, branch });
    path = undefined;
    branch = undefined;
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
    }
    // `detached`, `bare`, `HEAD <sha>` carry no branch → the record flushes without one.
  }
  flush();
  return worktrees;
}

/**
 * Commits behind/ahead of `primary` for `branch` (`rev-list --left-right --count`).
 * Returns `null/null` when the count could NOT be computed — the base ref is
 * unresolvable in this repo (a missing/foreign primary) — which is distinct from a
 * genuinely even `0/0`. Collapsing the two would make an unknown base read as
 * "fully merged" (a lying gauge, Rule 81ap).
 */
async function aheadBehind(
  git: GitExec,
  root: string,
  primary: string,
  branch: string,
): Promise<{ ahead: number | null; behind: number | null }> {
  const out = await git(root, ["rev-list", "--left-right", "--count", `${primary}...${branch}`], {
    reject: false,
  });
  const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(out);
  if (!match) return { ahead: null, behind: null };
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
  const identity = await repositoryIdentity(git, root);
  const { repository, forgeRepository } = identity;
  const activity = await readBranchActivity(git, root);
  const worktreesRaw = await git(root, ["worktree", "list", "--porcelain", "-z"], {
    reject: false,
  });
  const worktrees = parseWorktrees(worktreesRaw);

  // Key on the composite (repository, branch) so a checked-out worktree and its own
  // ref never double-count, while a branch name reused across repos stays distinct.
  const byKey = new Map<string, LocalWork>();
  const keyOf = (branch: string): string => `${repositoryKey(identity)}\n${branch}`;

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
      ...(forgeRepository === undefined ? {} : { forgeRepository }),
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
      id: `${repositoryKey(identity)}#${branch}`, // no worktree on disk → a branch-delete target
      repository,
      ...(forgeRepository === undefined ? {} : { forgeRepository }),
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

/** How many per-repo PR fetches run at once (each carries its own 15s deadline). */
const MAX_CONCURRENT_PR_FETCHES = 4;

/**
 * `Promise.all` with a concurrency cap; order-preserving, first rejection wins.
 * After a rejection the surviving workers stop picking up NEW items — the call
 * is already doomed, so launching more requests would only waste the network.
 */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index] as T);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Build the live `ProjectDetail` for a project from real git and (B2) live GitHub.
 * The local half is always real; the PR half fills when a `prSource` is wired (GitHub
 * auth resolved). The viewer is pinned to the GitHub login when available so ownership
 * reads correctly against both the PR author and — because local-work author is set to
 * this same viewer — the local rows too.
 */
export async function loadProjectDetail(
  deps: ProjectDetailSourceDeps,
  project: Project,
  prStates?: readonly PullRequestState[],
  /**
   * Per-repo PR-fetch narration (the slow, opaque phase). `prs-start` fires once
   * the forge-repo set is known (the honest total); a `repo-prs` fires as each
   * repo's PRs land. Absent on the local-only paint and in tests that don't care.
   */
  onProgress?: (event: ProjectDetailProgressEvent) => void,
): Promise<ProjectDetail> {
  const roots = await deps.resolveRepoRoots(project);
  const gitViewer = await resolveViewerLogin(deps.git, roots);

  // The provider-qualified forge identities among the roots, deduped. A local-only repo has no
  // structured identity, and an unregistered provider never falls through to GitHub.
  const identities = await Promise.all(roots.map((root) => repositoryIdentity(deps.git, root)));
  const forgeRepos = [
    ...new Map(
      identities.flatMap((identity) => {
        const forge = identity.forgeRepository;
        return forge === undefined ? [] : [[repositoryKey(identity), forge] as const];
      }),
    ).values(),
  ];
  const forgeTargets = forgeRepos.flatMap((repository) => {
    const source = deps.forgeRegistry?.sourceFor(repository);
    return source === undefined ? [] : [{ repository, source }];
  });

  let viewer = gitViewer;
  let prs: PullRequest[] = [];
  let truncated = false;
  let authUnavailable: "network" | undefined;
  if (forgeTargets.length > 0) {
    try {
      // GitHub is the only registered source today, so its login pins ownership. Keeping source
      // selection beside each repository prevents a GitLab identity from reaching this call.
      const githubViewer = await forgeTargets[0]?.source.resolveViewer();
      if (githubViewer) viewer = githubViewer;
      // The determinate total: how many forge repos will be fetched. The renderer
      // turns this into an honest progress fraction (no fabricated percentage).
      onProgress?.({ kind: "prs-start", total: forgeTargets.length });
      // Bounded fan-out: each request already carries a 15s deadline, so an
      // unbounded Promise.all over a many-repo workspace would stack one worst
      // case per repo. Four in flight keeps the worst case near one deadline.
      // A `repo-prs` fires as each repo lands, so the UI names exactly which repo
      // it is on; `fetched` is the running COMPLETION count (JS is single-threaded,
      // so the increment across the four workers never races).
      let fetched = 0;
      const results = await mapLimit(
        forgeTargets,
        MAX_CONCURRENT_PR_FETCHES,
        async ({ repository, source }) => {
          const result = await source.listPullRequests(repository, prStates);
          fetched += 1;
          onProgress?.({
            kind: "repo-prs",
            repo: forgeRepositorySlug(repository),
            index: fetched,
            total: forgeTargets.length,
            count: result.prs.length,
          });
          return result;
        },
      );
      prs = results.flatMap((result) => result.prs);
      truncated = results.some((result) => result.truncated);
    } catch (error) {
      // A network failure AFTER auth established the source (the post-establishment
      // outage): the source is fine, the fetch failed. Degrade to the local-only
      // list with the honest reason — never a hard-failed project.detail, and never
      // a lying "complete, zero PRs" (the hint names why the PR half is absent).
      // Non-network failures still throw: a broken response must surface.
      if (!isGitHubNetworkError(error)) throw error;
      prs = [];
      truncated = false;
      authUnavailable = "network";
    }
  }

  const perRepo = await Promise.all(
    roots.map((root) => loadRepoLocalWork(deps.git, root, project.primaryBranch, viewer)),
  );
  return {
    viewer: { login: viewer },
    locals: perRepo.flat(),
    prs,
    truncated,
    ...(authUnavailable === undefined ? {} : { authUnavailable }),
  };
}

/**
 * The real source effects. `resolveRepoRoots` maps a project onto its repo roots: a
 * `repo` project is its own open path; a `workspace` honours the stored inclusion
 * set (so an excluded repo never appears), falling back to discovering every repo
 * under the path only for a legacy project saved before the selection was persisted.
 */
export function defaultProjectDetailSourceDeps(
  git: GitExec,
  forgeRegistry?: ProjectForgeRegistry,
): ProjectDetailSourceDeps {
  return {
    git,
    forgeRegistry,
    async resolveRepoRoots(project: Project): Promise<readonly string[]> {
      if (project.kind === "repo") return [project.openPath || project.path];
      // Honour the user's include/exclude choice, persisted at add time.
      if (project.includedRepoPaths && project.includedRepoPaths.length > 0) {
        return project.includedRepoPaths;
      }
      // Legacy project (no persisted selection) → discover all repos under the path.
      const result = await discoverProject(
        defaultProjectDiscoveryDeps(git),
        project.path,
        "workspace",
      );
      return result.repos.map((repo) => repo.path);
    },
  };
}
