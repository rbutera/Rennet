import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { DiscoveredRepo, DiscoveryResult, ProjectKind } from "@rennet/protocol";
import type { GitExec } from "./git-range-diff";
import { parseRemoteIdentity } from "./worktree-discovery";

/**
 * Read-only project discovery (issue #29, step 2 substrate). The user has pointed
 * Rennet at a WORKSPACE (a folder of repos) or a single PROJECT REPO; discovery
 * reads what is there and returns EDITABLE DEFAULTS, never questions. Every effect
 * is injected so the whole thing is testable and so a test can prove it never
 * mutates the index or the working tree — the only git verbs it issues are reads
 * (`rev-parse`, `for-each-ref`, `remote get-url`, `symbolic-ref`, `worktree list`).
 */

export interface ProjectDiscoveryDeps {
  /** The injected git runner (no shell). */
  git: GitExec;
  /** Immediate subdirectory names of a path, for workspace scanning. `[]` on any error. */
  listSubdirs(directory: string): Promise<readonly string[]>;
  /** Whether a directory carries a `.git` entry (the filesystem "walk" signal). */
  hasGitEntry(directory: string): Promise<boolean>;
}

/** Trim git stdout and read the first non-empty line. */
function firstLine(output: string): string {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
}

/** Is this path a git working tree? (`rev-parse --is-inside-work-tree` → `true`). */
async function isWorkTree(git: GitExec, path: string): Promise<boolean> {
  const out = await git(path, ["rev-parse", "--is-inside-work-tree"], { reject: false });
  return firstLine(out) === "true";
}

/** Count local branches (`for-each-ref refs/heads`). */
async function countBranches(git: GitExec, path: string): Promise<number> {
  const out = await git(path, ["for-each-ref", "--format=%(refname:short)", "refs/heads"], {
    reject: false,
  });
  return out.split("\n").filter((line) => line.trim().length > 0).length;
}

/** `host/owner/name` from the origin remote, or undefined when there is no forge remote. */
async function remoteIdentity(git: GitExec, path: string): Promise<string | undefined> {
  const url = firstLine(await git(path, ["remote", "get-url", "origin"], { reject: false }));
  if (!url) return undefined;
  const identity = parseRemoteIdentity(url);
  return identity ? `${identity.host}/${identity.owner}/${identity.name}` : undefined;
}

/**
 * The detected default branch: origin/HEAD, else the current branch, else `main`.
 * Never mutates; a detached HEAD or a fresh repo simply falls through to `main`.
 */
async function detectPrimaryBranch(git: GitExec, path: string): Promise<string> {
  const originHead = firstLine(
    await git(path, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
      reject: false,
    }),
  );
  if (originHead.startsWith("origin/")) {
    const name = originHead.slice("origin/".length);
    if (name.length > 0) return name;
  }
  const current = firstLine(
    await git(path, ["rev-parse", "--abbrev-ref", "HEAD"], { reject: false }),
  );
  if (current && current !== "HEAD") return current;
  return "main";
}

/** Describe one repo at `path` for the toggle rows. `name` is its display label. */
async function describeRepo(git: GitExec, path: string, name: string): Promise<DiscoveredRepo> {
  const branches = await countBranches(git, path);
  const remote = await remoteIdentity(git, path);
  return { name, path, branches, ...(remote ? { remote } : {}) };
}

/**
 * Discover a project from the pointed-at path. For a `repo` the path itself is the
 * repo; for a `workspace` the immediate subdirectories are scanned and each git
 * working tree becomes a toggle row. A walk-vs-list disagreement (a subdir that
 * carries a `.git` entry but git does not accept as a work tree, or vice versa) is
 * SURFACED in `reconciliation` rather than silently resolved.
 */
export async function discoverProject(
  deps: ProjectDiscoveryDeps,
  path: string,
  kind: ProjectKind,
): Promise<DiscoveryResult> {
  const { git } = deps;

  if (kind === "repo") {
    const repos = (await isWorkTree(git, path))
      ? [await describeRepo(git, path, basename(path) || path)]
      : [];
    return {
      path,
      kind,
      repos,
      primaryBranch: await detectPrimaryBranch(git, path),
      source: "local",
    };
  }

  // Workspace: scan the immediate children.
  const subdirs = [...(await deps.listSubdirs(path))].sort((a, b) => a.localeCompare(b));
  const repos: DiscoveredRepo[] = [];
  const walkOnly: string[] = []; // has a `.git` entry but git rejects it
  const listOnly: string[] = []; // git accepts it but it carries no `.git` entry
  for (const name of subdirs) {
    const child = join(path, name);
    const [walk, list] = await Promise.all([deps.hasGitEntry(child), isWorkTree(git, child)]);
    if (list) repos.push(await describeRepo(git, child, name));
    if (walk && !list) walkOnly.push(name);
    if (list && !walk) listOnly.push(name); // e.g. a linked worktree whose .git is a file
  }

  // The primary branch is the workspace's most-common repo default, else the first
  // repo's default, else `main` — a sensible editable default, never a question.
  const primaryBranch =
    repos.length > 0 ? await detectPrimaryBranch(git, repos[0]?.path ?? path) : "main";

  const reconciliation = reconciliationNote(walkOnly, listOnly);
  return {
    path,
    kind,
    repos,
    primaryBranch,
    ...(reconciliation ? { reconciliation } : {}),
    source: "local",
  };
}

/** A terse account of a walk-vs-list disagreement, or undefined when the two agree. */
function reconciliationNote(
  walkOnly: readonly string[],
  listOnly: readonly string[],
): string | undefined {
  const parts: string[] = [];
  if (walkOnly.length > 0)
    parts.push(`${walkOnly.join(", ")} look like repos but git did not confirm them`);
  if (listOnly.length > 0) parts.push(`${listOnly.join(", ")} are worktrees without a local .git`);
  return parts.length > 0 ? parts.join("; ") : undefined;
}

/** The real discovery effects: filesystem listing + `.git`-presence probe. */
export function defaultProjectDiscoveryDeps(git: GitExec): ProjectDiscoveryDeps {
  return {
    git,
    async listSubdirs(directory: string): Promise<readonly string[]> {
      try {
        const entries = await readdir(directory, { withFileTypes: true });
        return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
      } catch {
        return [];
      }
    },
    async hasGitEntry(directory: string): Promise<boolean> {
      try {
        const entries = await readdir(directory);
        return entries.includes(".git");
      } catch {
        return false;
      }
    },
  };
}
