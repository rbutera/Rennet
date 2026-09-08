import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { BUILTIN_PR_WORKTREE_PATTERN, BUILTIN_WORKTREE_PATTERN } from "@rennet/core";
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
 * Where Rennet places its worktrees: one root plus two patterns (workspace-settings
 * D1/D2). Resolved off the settings ladder for the repository being bound; the values
 * here are the builtins, which are byte-for-byte the shapes the previous release
 * hardcoded — so an install that has never touched a rung places nothing differently.
 */
export interface WorktreePlacement {
  /** The directory every Rennet worktree hangs under. */
  readonly root: string;
  /** The BRANCH pattern: `{repo}` / `{name}` / `{owner}` / `{branch}`. */
  readonly pattern: string;
  /** The PULL-REQUEST pattern: `{owner}` / `{name}` / `{repo}` / `{number}`. */
  readonly prPattern: string;
}

/** The placement an untouched install resolves: `<dataDir>/worktrees` with both
 *  builtin patterns. The one place group 1's callers name the defaults, so wiring the
 *  resolved settings in is a change of argument, not of shape. */
export function defaultWorktreePlacement(dataDir: string): WorktreePlacement {
  return {
    root: join(dataDir, "worktrees"),
    pattern: BUILTIN_WORKTREE_PATTERN,
    prPattern: BUILTIN_PR_WORKTREE_PATTERN,
  };
}

/**
 * The worktree ROOT a stored value means (workspace-settings D1). An unset value is
 * `<dataDir>/worktrees`; `~` expands; a relative value resolves against the data
 * directory, because a daemon started with another `--data-dir` must not silently
 * write into whatever directory it happened to be launched from.
 */
export function resolveWorktreeRoot(dataDir: string, value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return join(dataDir, "worktrees");
  const expanded =
    trimmed === "~" || trimmed.startsWith(`~${sep}`) || trimmed.startsWith("~/")
      ? join(homedir(), trimmed.slice(1))
      : trimmed;
  return isAbsolute(expanded) ? expanded : resolve(dataDir, expanded);
}

/** The token values one placement can substitute. A token the caller does not carry is
 *  `undefined` — a pattern that asks for it is REFUSED rather than filled with a guess. */
export type WorktreeTokens = Readonly<Record<string, string | undefined>>;

const TOKEN = /\{([^{}]*)\}/g;

/**
 * Render one placement pattern under `root`, or THROW with the reason (D2).
 *
 * Three refusals, all of them about a path Rennet would otherwise create somewhere it
 * was never told to: a token this placement does not carry (a typo, or `{number}` in a
 * branch pattern — a snapshot has a number and a branch has none, which is why the two
 * patterns are two grammars), a result that is absolute, and a result that leaves the
 * root. The check runs on the RENDERED string, so a `..` arriving through a token value
 * is caught exactly like one written into the pattern.
 *
 * The reason is the message: the settings write validates through this function with
 * placeholder tokens and reports what it says, so the reviewer is told which token or
 * which escape was refused rather than "invalid".
 */
export function renderWorktreePattern(
  root: string,
  pattern: string,
  tokens: WorktreeTokens,
): string {
  const trimmed = pattern.trim();
  if (trimmed === "") throw new Error("worktree pattern: names no path");
  const known = Object.keys(tokens)
    .map((name) => `{${name}}`)
    .join(", ");
  const rendered = trimmed.replace(TOKEN, (_match, name: string) => {
    if (!(name in tokens)) {
      throw new Error(`worktree pattern: unknown token {${name}} — this pattern takes ${known}`);
    }
    const value = tokens[name];
    if (value === undefined || value === "") {
      throw new Error(`worktree pattern: {${name}} has no value for this worktree`);
    }
    return value;
  });
  if (isAbsolute(rendered)) {
    throw new Error(
      `worktree pattern: "${rendered}" is absolute — a pattern is relative to the worktree root`,
    );
  }
  const base = resolve(root);
  const target = resolve(root, rendered);
  if (target === base || !target.startsWith(base + sep)) {
    throw new Error(`worktree pattern: "${rendered}" resolves outside the worktree root`);
  }
  // `join`, not `resolve`: a relative root stays relative, so a caller's own spelling of
  // the data directory is preserved byte-for-byte.
  return join(root, rendered);
}

/** Placeholder token values for VALIDATING a pattern before it is stored — every token
 *  the grammar has, each a plain segment, so the only thing that can refuse the write is
 *  the pattern itself. */
const PLACEHOLDERS = {
  branch: { repo: "repo", name: "name", owner: "owner", branch: "branch" },
  "pull-request": { owner: "owner", name: "name", repo: "repo", number: "1" },
} as const;

/**
 * Refuse a pattern the reviewer is about to store, with the reason, BEFORE it is
 * persisted — the same rendering the binding does, over placeholder values. A pattern
 * that survives this places somewhere under the root for every token value that is not
 * itself an escape, and a token value cannot be one: a branch name cannot contain `..`
 * (`git check-ref-format`), and the repo key is an escaped path.
 */
export function assertWorktreePattern(kind: "branch" | "pull-request", pattern: string): void {
  renderWorktreePattern(sep === "\\" ? "C:\\rennet" : "/rennet", pattern, PLACEHOLDERS[kind]);
}

/**
 * Where a PULL-REQUEST snapshot lives: `root` plus the pull-request pattern, whose
 * builtin `{owner}/{name}/pr-{number}` is the `<root>/<owner>/<name>/pr-N` the previous
 * release hardcoded. A snapshot has no branch, so `{branch}` is not one of its tokens.
 */
export function prWorktreePath(
  root: string,
  pattern: string,
  tokens: {
    readonly owner?: string;
    readonly name?: string;
    /** The escaped realpath key, for a reviewer who files snapshots beside branches. */
    readonly repo?: string;
    readonly number: number;
  },
): string {
  return renderWorktreePattern(root, pattern, {
    owner: tokens.owner,
    name: tokens.name,
    repo: tokens.repo,
    number: String(tokens.number),
  });
}

/**
 * Where a session's Rennet-created BRANCH worktree lives (session-bound-workspace D1):
 * `root` plus the branch pattern, whose builtin `{repo}/{branch}` is the
 * `<root>/<repoKey>/<branch as folders>` the previous release hardcoded. One per
 * `(repository, branch)`, so a second session on the same branch of the same repo binds
 * to the same workspace rather than a second checkout of it.
 *
 * The branch is laid down as PATH SEGMENTS, not an escaped single name: `git check-ref-format`
 * already forbids every character `join` would have to escape (`..`, a trailing `/`, control
 * characters, `\`, `~`, `^`, `:`, `?`, `*`, `[`), and segmenting keeps the mapping injective
 * — `feat/a-b` and `feat-a-b` are two directories, where one escaped name would be one.
 */
export function branchWorktreePath(
  root: string,
  pattern: string,
  tokens: {
    /** The escaped realpath key — today's middle segment. */
    readonly repo?: string;
    /** The repository directory's basename. */
    readonly name?: string;
    /** The forge owner when a remote resolves, else `local`. */
    readonly owner?: string;
    readonly branch: string;
  },
): string {
  return renderWorktreePattern(root, pattern, {
    repo: tokens.repo,
    name: tokens.name,
    owner: tokens.owner,
    branch: tokens.branch,
  });
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
