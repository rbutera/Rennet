import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import type { GitExec } from "./git-range-diff";
import { parseWorktrees } from "./worktree-discovery";

/**
 * A worktree per reviewed PR (historical-PR review): every PR review opened from a
 * clone gets a detached worktree at the reviewed head OID — retrospective included,
 * so the agent can run the change's own tests at the historical head. A successor
 * (same PR, new head) replaces the old worktree; broader lifecycle management is the
 * worktree-management UI (#423).
 *
 * Setup instructions: `<worktree>/.rennet/setup` — a plain text file, one shell
 * command per line (`#` comments and blanks skipped) — runs automatically after the
 * worktree is created, sequentially, cwd the worktree. Output lands in
 * `<worktree>/.rennet/setup.log` and the verdict in `<worktree>/.rennet/setup-status.json`
 * (`running` / `ok` / `failed` / `none`). Setup NEVER blocks or fails the review:
 * reading a diff needs no installed deps; a failed setup is honest status, not a wall.
 */

/**
 * Where per-REVIEW evidence worktrees live under the app data dir: the detached
 * checkout board-drafting seats read reviewed bytes from when the review is a
 * range capture (a branch or PR review) and the ambient clone may sit on any
 * ref. Keyed by review id; `ensurePrWorktree` replaces it in place when a round
 * advances the reviewed head.
 */
export function reviewWorktreePath(dataDir: string, reviewId: string): string {
  return join(dataDir, "worktrees", "review", reviewId);
}

/** Where per-PR worktrees live under the app data dir. */
export function prWorktreePath(
  dataDir: string,
  repo: { owner: string; name: string },
  prNumber: number,
): string {
  return join(dataDir, "worktrees", repo.owner, repo.name, `pr-${prNumber}`);
}

/**
 * Where a session's Rennet-created BRANCH worktree lives (session-bound-workspace D1): one
 * per `(repository, branch)`, so a second session on the same branch of the same repo binds
 * to the same workspace rather than a second checkout of it.
 *
 * The branch is laid down as PATH SEGMENTS, not an escaped single name: `git check-ref-format`
 * already forbids every character `join` would have to escape (`..`, a trailing `/`, control
 * characters, `\`, `~`, `^`, `:`, `?`, `*`, `[`), and segmenting keeps the mapping injective
 * — `feat/a-b` and `feat-a-b` are two directories, where one escaped name would be one.
 */
export function branchWorktreePath(dataDir: string, repoKey: string, branch: string): string {
  return join(dataDir, "worktrees", repoKey, ...branch.split("/"));
}

/**
 * The worktree of this repository that ALREADY has `branch` checked out, or `undefined`.
 *
 * This is what makes "the reviewer's own checkout when it is on the reviewed branch" a fact
 * rather than an assumption, and it covers the reviewer's own second worktree too: git
 * refuses `worktree add` for a branch checked out somewhere else, so binding blind would
 * fail on exactly the tree we should have bound to. Unreadable git ⇒ `undefined`, and the
 * caller creates.
 */
export async function worktreeForBranch(
  git: GitExec,
  cloneRoot: string,
  branch: string,
): Promise<string | undefined> {
  const listed = await git(cloneRoot, ["worktree", "list", "--porcelain", "-z"], {
    reject: false,
  }).catch(() => "");
  return parseWorktrees(listed).find((entry) => entry.branch === branch)?.path;
}

/**
 * Ensure a worktree of `cloneRoot` with `branch` CHECKED OUT (not detached) exists at
 * `worktreePath` — the session's workspace for a branch review of a branch the reviewer's
 * own checkout is not on. Checked out rather than detached because a round commits on the
 * session's branch here, which a detached head cannot do.
 *
 * Idempotent: an existing worktree already on the branch is returned untouched; one that
 * has drifted onto another ref is switched in place, so a session keeps its workspace path
 * for its whole life. A path with a stale admin entry (a directory removed by hand) is
 * pruned before the add, which is the only thing that makes `worktree add` accept it again.
 */
export async function ensureBranchWorktree(
  git: GitExec,
  cloneRoot: string,
  worktreePath: string,
  branch: string,
): Promise<{ path: string; created: boolean }> {
  if (existsSync(join(worktreePath, ".git"))) {
    const current = (
      await git(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"], { reject: false })
    ).trim();
    if (current === branch) return { path: worktreePath, created: false };
    await git(worktreePath, ["checkout", branch]);
    return { path: worktreePath, created: false };
  }
  await mkdir(join(worktreePath, ".."), { recursive: true });
  await git(cloneRoot, ["worktree", "prune"], { reject: false });
  await git(cloneRoot, ["worktree", "add", worktreePath, branch]);
  return { path: worktreePath, created: true };
}

export type SetupStatus =
  | { status: "none" }
  | { status: "running" }
  | { status: "ok" }
  | { status: "failed"; command: string; exitCode: number };

/**
 * Ensure a detached worktree for the PR exists at `headOid`, replacing a stale one
 * (a superseded head) in place. Returns whether the worktree was (re)created —
 * setup only re-runs on a fresh checkout, never on a plain re-open.
 */
export async function ensurePrWorktree(
  git: GitExec,
  cloneRoot: string,
  worktreePath: string,
  headOid: string,
): Promise<{ path: string; created: boolean }> {
  if (existsSync(join(worktreePath, ".git"))) {
    const current = (await git(worktreePath, ["rev-parse", "HEAD"], { reject: false })).trim();
    if (current === headOid) return { path: worktreePath, created: false };
    // Superseded head: the old checkout is replaced, forcibly — it is a managed
    // detached checkout, never the user's own working tree.
    await git(cloneRoot, ["worktree", "remove", "--force", worktreePath], { reject: false });
    await rm(worktreePath, { recursive: true, force: true });
  }
  await mkdir(join(worktreePath, ".."), { recursive: true });
  await git(cloneRoot, ["worktree", "add", "--detach", worktreePath, headOid]);
  return { path: worktreePath, created: true };
}

/** Read the worktree's recorded setup status (absent file ⇒ never ran ⇒ `none`). */
export function readSetupStatus(worktreePath: string): SetupStatus {
  try {
    return JSON.parse(
      readFileSync(join(worktreePath, ".rennet", "setup-status.json"), "utf8"),
    ) as SetupStatus;
  } catch {
    return { status: "none" };
  }
}

/** The last `maxBytes` of the setup log, or empty when none exists. */
export function readSetupLogTail(worktreePath: string, maxBytes = 4096): string {
  try {
    const log = readFileSync(join(worktreePath, ".rennet", "setup.log"), "utf8");
    return log.length > maxBytes ? log.slice(-maxBytes) : log;
  } catch {
    return "";
  }
}

/**
 * Run the worktree's `.rennet/setup` commands, recording status + log as it goes.
 * Resolves when setup finishes; callers fire-and-forget it so a slow install never
 * delays the review landing. No setup file ⇒ status `none`, nothing runs.
 */
export async function runPrWorktreeSetup(worktreePath: string): Promise<SetupStatus> {
  const setupFile = join(worktreePath, ".rennet", "setup");
  const metaDir = join(worktreePath, ".rennet");
  const statusFile = join(metaDir, "setup-status.json");
  const logFile = join(metaDir, "setup.log");
  let commands: string[];
  try {
    commands = readFileSync(setupFile, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  } catch {
    return { status: "none" };
  }
  await mkdir(metaDir, { recursive: true });
  const record = async (status: SetupStatus) => {
    await writeFile(statusFile, JSON.stringify(status));
    return status;
  };
  await record({ status: "running" });
  await writeFile(logFile, "");
  for (const command of commands) {
    appendFileSync(logFile, `$ ${command}\n`);
    const result = await execa("sh", ["-c", command], {
      cwd: worktreePath,
      reject: false,
      all: true,
    });
    appendFileSync(logFile, `${result.all ?? ""}\n`);
    if (result.exitCode !== 0) {
      return record({ status: "failed", command, exitCode: result.exitCode ?? 1 });
    }
  }
  return record({ status: "ok" });
}
