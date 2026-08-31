import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import {
  type Locus,
  LocusDistroMismatchError,
  LocusPathUntranslatableError,
  locusCommand,
  stripShellControl,
  toDistroPath,
} from "@rennet/core";
import type {
  BranchRefRoundSourceLandingAttempt,
  BranchRefRoundSourceLandingReceipt,
  RoundTermination,
  RoundWorkspaceAttempt,
  RoundWorkspaceReceipt,
} from "@rennet/protocol";
import { execa } from "execa";
import type { GitExec } from "./git-range-diff";

const ZERO_OID = "0000000000000000000000000000000000000000";

export const ROUND_SOURCE_COMMIT_MESSAGE = "rennet: round source";
export const ROUND_COMMIT_MESSAGE = "Apply round work order";

export interface RoundProcessResult {
  readonly exitCode: number | null;
  readonly signal?: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly combinedOutput: string;
}

export type RoundProcessExec = (
  command: { readonly file: string; readonly args: readonly string[]; readonly cwd?: string },
  input?: string,
) => Promise<RoundProcessResult>;

export const execaRoundProcess: RoundProcessExec = async (command, input) => {
  const result = await execa(command.file, [...command.args], {
    ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
    ...(input === undefined ? {} : { input }),
    reject: false,
    shell: false,
    all: true,
  });
  return {
    exitCode: result.exitCode ?? null,
    ...(result.signal === undefined ? {} : { signal: result.signal }),
    stdout: result.stdout,
    stderr: result.stderr,
    combinedOutput: result.all ?? `${result.stdout}\n${result.stderr}`,
  };
};

type WorktreeMismatchReason =
  | "not-a-worktree"
  | "different-repository"
  | "attached"
  | "different-head";

export type RoundWorktreeInspection =
  | { readonly kind: "absent" }
  | { readonly kind: "exact"; readonly head: string }
  | {
      readonly kind: "mismatch";
      readonly reason: WorktreeMismatchReason;
      readonly expectedHead: string;
      readonly actualHead?: string;
    };

type RoundWorktreeMismatch = Extract<RoundWorktreeInspection, { kind: "mismatch" }>;

export class RoundWorktreeMismatchError extends Error {
  override readonly name = "RoundWorktreeMismatchError";

  constructor(readonly mismatch: RoundWorktreeMismatch) {
    super(
      `Round worktree does not match its reservation: ${mismatch.reason}` +
        (mismatch.actualHead === undefined ? "" : ` at ${mismatch.actualHead}`),
    );
  }
}

export class RoundWorktreeDirtyError extends Error {
  override readonly name = "RoundWorktreeDirtyError";

  constructor(readonly worktreePath: string) {
    super(`Round worktree is dirty and cannot be removed: ${worktreePath}`);
  }
}

export class RoundBaseHeadNotAncestorError extends Error {
  override readonly name = "RoundBaseHeadNotAncestorError";

  constructor(
    readonly baseHead: string,
    readonly head: string,
  ) {
    super(`Round base ${baseHead} is not an ancestor of ${head}`);
  }
}

export class RoundSourceRefMismatchError extends Error {
  override readonly name = "RoundSourceRefMismatchError";

  constructor(readonly ref: string) {
    super(`Round source ref changed before release: ${ref}`);
  }
}

export class RoundLandingConflictError extends Error {
  override readonly name = "RoundLandingConflictError";

  constructor(readonly detail: string) {
    super(`Round changes do not apply cleanly to the source checkout: ${detail}`);
  }
}

export class RoundBranchLandingConflictError extends Error {
  override readonly name = "RoundBranchLandingConflictError";

  constructor(readonly detail: string) {
    super(`Round selected-branch landing conflicts: ${detail}`);
  }
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
}

/** Translate a persisted host-visible worktree path before passing it as a git argv. */
export function roundWorktreeGitPath(locus: Locus, worktreePath: string): string {
  if (locus.kind === "host") return worktreePath;
  const translated = toDistroPath(worktreePath, locus.distro);
  if (translated === null) throw new LocusPathUntranslatableError(worktreePath, locus.distro);
  return translated;
}

async function resolveCommit(git: GitExec, root: string, value: string): Promise<string> {
  return (await git(root, ["rev-parse", "--verify", `${value}^{commit}`])).trim();
}

async function resolveTree(git: GitExec, root: string, value: string): Promise<string> {
  const kind = (await git(root, ["cat-file", "-t", value])).trim();
  if (kind !== "tree") throw new Error(`Round source object is not a tree: ${value}`);
  return (await git(root, ["rev-parse", "--verify", value])).trim();
}

async function readOptionalCommit(
  git: GitExec,
  root: string,
  value: string,
): Promise<string | null> {
  const output = await git(root, ["rev-parse", "--verify", "--quiet", `${value}^{commit}`], {
    reject: false,
  });
  const commit = output.trim();
  return commit.length === 0 ? null : commit;
}

async function readOptionalObject(
  git: GitExec,
  root: string,
  value: string,
): Promise<string | null> {
  const output = await git(root, ["rev-parse", "--verify", "--quiet", value], {
    reject: false,
  });
  const oid = output.trim();
  return oid.length === 0 ? null : oid;
}

async function readWorktree(
  git: GitExec,
  repoRoot: string,
  worktreePath: string,
): Promise<
  | { readonly kind: "absent" }
  | {
      readonly kind: "worktree";
      readonly head: string;
      readonly detached: boolean;
      readonly sameRepository: boolean;
    }
  | { readonly kind: "not-a-worktree" }
> {
  try {
    const inside = (
      await git(worktreePath, ["rev-parse", "--is-inside-work-tree"], { reject: false })
    ).trim();
    if (inside !== "true") {
      return (await pathExists(worktreePath)) ? { kind: "not-a-worktree" } : { kind: "absent" };
    }
    const prefix = (await git(worktreePath, ["rev-parse", "--show-prefix"])).trim();
    if (prefix.length > 0) return { kind: "not-a-worktree" };
    const [head, repoCommonDir, worktreeCommonDir, branch] = await Promise.all([
      resolveCommit(git, worktreePath, "HEAD"),
      git(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      git(worktreePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      git(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"], { reject: false }),
    ]);
    return {
      kind: "worktree",
      head,
      detached: branch.trim().length === 0,
      sameRepository: repoCommonDir.trim() === worktreeCommonDir.trim(),
    };
  } catch (error) {
    if (error instanceof LocusDistroMismatchError) throw error;
    return (await pathExists(worktreePath)) ? { kind: "not-a-worktree" } : { kind: "absent" };
  }
}

export async function inspectRoundWorktree(input: {
  readonly git: GitExec;
  readonly locus: Locus;
  readonly repoRoot: string;
  readonly worktreePath: string;
  readonly sourceHead: string;
}): Promise<RoundWorktreeInspection> {
  const expectedHead = await resolveCommit(input.git, input.repoRoot, input.sourceHead);
  const worktree = await readWorktree(input.git, input.repoRoot, input.worktreePath);
  if (worktree.kind === "absent") return worktree;
  if (worktree.kind === "not-a-worktree") {
    return { kind: "mismatch", reason: "not-a-worktree", expectedHead };
  }
  if (!worktree.sameRepository) {
    return {
      kind: "mismatch",
      reason: "different-repository",
      expectedHead,
      actualHead: worktree.head,
    };
  }
  if (!worktree.detached) {
    return {
      kind: "mismatch",
      reason: "attached",
      expectedHead,
      actualHead: worktree.head,
    };
  }
  if (worktree.head !== expectedHead) {
    return {
      kind: "mismatch",
      reason: "different-head",
      expectedHead,
      actualHead: worktree.head,
    };
  }
  return { kind: "exact", head: worktree.head };
}

export async function prepareRoundWorktree(input: {
  readonly git: GitExec;
  readonly locus: Locus;
  readonly repoRoot: string;
  readonly worktreePath: string;
  readonly sourceHead: string;
}): Promise<{ readonly path: string; readonly head: string; readonly created: boolean }> {
  const current = await inspectRoundWorktree(input);
  if (current.kind === "exact") {
    return { path: input.worktreePath, head: current.head, created: false };
  }
  if (current.kind === "mismatch") throw new RoundWorktreeMismatchError(current);

  await input.git(input.repoRoot, [
    "worktree",
    "add",
    "--detach",
    roundWorktreeGitPath(input.locus, input.worktreePath),
    input.sourceHead,
  ]);
  const prepared = await inspectRoundWorktree(input);
  if (prepared.kind !== "exact") {
    const mismatch: RoundWorktreeMismatch =
      prepared.kind === "mismatch"
        ? prepared
        : {
            kind: "mismatch",
            reason: "not-a-worktree",
            expectedHead: await resolveCommit(input.git, input.repoRoot, input.sourceHead),
          };
    throw new RoundWorktreeMismatchError(mismatch);
  }
  return { path: input.worktreePath, head: prepared.head, created: true };
}

/** Prepare one persisted workspace attempt without consulting ambient checkout state. */
export async function prepareRoundWorkspace(input: {
  readonly git: GitExec;
  readonly locus: Locus;
  readonly repoRoot: string;
  readonly operationId: string;
  readonly attempt: RoundWorkspaceAttempt;
  readonly now?: () => number;
}): Promise<RoundWorkspaceReceipt> {
  const source = await createOrAdoptRoundSourceCommit({
    git: input.git,
    repoRoot: input.repoRoot,
    operationId: input.operationId,
    treeOid: input.attempt.sourceTreeOid,
    parentHead: input.attempt.sourceParentHead,
  });
  await prepareRoundWorktree({
    git: input.git,
    locus: input.locus,
    repoRoot: input.repoRoot,
    worktreePath: input.attempt.worktreePath,
    sourceHead: source.commit,
  });
  return {
    ...input.attempt,
    sourceHead: source.commit,
    preparedAt: Math.max((input.now ?? Date.now)(), input.attempt.startedAt),
  };
}

async function assertAncestor(
  git: GitExec,
  root: string,
  baseHead: string,
  head: string,
): Promise<void> {
  try {
    await git(root, ["merge-base", "--is-ancestor", baseHead, head]);
  } catch (error) {
    if (error instanceof LocusDistroMismatchError) throw error;
    throw new RoundBaseHeadNotAncestorError(baseHead, head);
  }
}

export async function removeRoundWorktree(input: {
  readonly git: GitExec;
  readonly locus: Locus;
  readonly repoRoot: string;
  readonly worktreePath: string;
  readonly sourceHead: string;
}): Promise<{ readonly removed: boolean }> {
  const worktree = await readWorktree(input.git, input.repoRoot, input.worktreePath);
  if (worktree.kind === "absent") return { removed: false };
  const expectedHead = await resolveCommit(input.git, input.repoRoot, input.sourceHead);
  if (worktree.kind === "not-a-worktree") {
    throw new RoundWorktreeMismatchError({
      kind: "mismatch",
      reason: "not-a-worktree",
      expectedHead,
    });
  }
  if (!worktree.sameRepository || !worktree.detached) {
    throw new RoundWorktreeMismatchError({
      kind: "mismatch",
      reason: worktree.sameRepository ? "attached" : "different-repository",
      expectedHead,
      actualHead: worktree.head,
    });
  }
  await assertAncestor(input.git, input.worktreePath, expectedHead, worktree.head);
  const status = await input.git(input.worktreePath, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (status.length > 0) throw new RoundWorktreeDirtyError(input.worktreePath);
  await input.git(input.repoRoot, [
    "worktree",
    "remove",
    roundWorktreeGitPath(input.locus, input.worktreePath),
  ]);
  return { removed: true };
}

export function roundSourceRef(operationId: string): string {
  const key = createHash("sha256").update(operationId).digest("hex");
  return `refs/rennet/round-sources/${key}`;
}

export interface RoundSourceCommit {
  readonly ref: string;
  readonly commit: string;
  readonly treeOid: string;
  readonly parentHead: string;
  readonly created: boolean;
}

export async function createOrAdoptRoundSourceCommit(input: {
  readonly git: GitExec;
  readonly repoRoot: string;
  readonly operationId: string;
  readonly treeOid: string;
  readonly parentHead: string;
}): Promise<RoundSourceCommit> {
  const ref = roundSourceRef(input.operationId);
  const [treeOid, parentHead] = await Promise.all([
    resolveTree(input.git, input.repoRoot, input.treeOid),
    resolveCommit(input.git, input.repoRoot, input.parentHead),
  ]);
  const existingObject = await readOptionalObject(input.git, input.repoRoot, ref);
  const existingCommit = await readOptionalCommit(input.git, input.repoRoot, ref);
  if (existingCommit !== null) {
    const [existingTree, lineage] = await Promise.all([
      resolveTree(input.git, input.repoRoot, `${existingCommit}^{tree}`),
      input.git(input.repoRoot, ["rev-list", "--parents", "-n", "1", existingCommit]),
    ]);
    const lineageParts = lineage.trim().split(/\s+/);
    if (
      existingTree === treeOid &&
      lineageParts.length === 2 &&
      lineageParts[0] === existingCommit &&
      lineageParts[1] === parentHead
    ) {
      return { ref, commit: existingCommit, treeOid, parentHead, created: false };
    }
  }

  const parentTree = await resolveTree(input.git, input.repoRoot, `${parentHead}^{tree}`);
  if (existingObject === null && parentTree === treeOid) {
    return { ref, commit: parentHead, treeOid, parentHead, created: false };
  }

  const commit = (
    await input.git(input.repoRoot, [
      "commit-tree",
      treeOid,
      "-p",
      parentHead,
      "-m",
      ROUND_SOURCE_COMMIT_MESSAGE,
    ])
  ).trim();
  await input.git(input.repoRoot, ["update-ref", ref, commit, existingObject ?? ZERO_OID]);
  return { ref, commit, treeOid, parentHead, created: true };
}

function selectedBranchRef(branch: string): string {
  return `refs/heads/${branch}`;
}

async function checkedOutWorktreeForBranch(
  git: GitExec,
  repoRoot: string,
  ref: string,
): Promise<string | null> {
  const output = await git(repoRoot, ["worktree", "list", "--porcelain", "-z"]);
  let worktree: string | undefined;
  for (const token of output.split("\0")) {
    if (token.startsWith("worktree ")) {
      worktree = token.slice("worktree ".length);
      continue;
    }
    if (token === `branch ${ref}`) return worktree ?? null;
    if (token.length === 0) worktree = undefined;
  }
  return null;
}

export async function planRoundBranchLanding(input: {
  readonly git: GitExec;
  readonly repoRoot: string;
  readonly executionId: string;
  readonly branch: string;
  readonly expectedHead: string;
  readonly baselineCommit: string;
  readonly workerHead: string;
  readonly startedAt: number;
}): Promise<BranchRefRoundSourceLandingAttempt> {
  await input.git(input.repoRoot, ["check-ref-format", "--branch", input.branch]);
  const ref = selectedBranchRef(input.branch);
  const [expectedHead, baselineCommit, workerHead, selectedHead] = await Promise.all([
    resolveCommit(input.git, input.repoRoot, input.expectedHead),
    resolveCommit(input.git, input.repoRoot, input.baselineCommit),
    resolveCommit(input.git, input.repoRoot, input.workerHead),
    resolveCommit(input.git, input.repoRoot, ref),
  ]);
  if (baselineCommit !== expectedHead) {
    throw new RoundBranchLandingConflictError(
      `round baseline ${baselineCommit} is not selected branch ${input.branch} at ${expectedHead}`,
    );
  }
  if (selectedHead !== expectedHead) {
    throw new RoundBranchLandingConflictError(
      `branch ${input.branch} moved from ${expectedHead} to ${selectedHead}`,
    );
  }
  await assertAncestor(input.git, input.repoRoot, expectedHead, workerHead);
  return {
    effect: "source-landing",
    strategy: "branch-ref-v1",
    executionId: input.executionId,
    branch: input.branch,
    expectedHead,
    baselineCommit,
    workerHead,
    startedAt: input.startedAt,
  };
}

export async function landRoundBranch(input: {
  readonly git: GitExec;
  readonly repoRoot: string;
  readonly attempt: BranchRefRoundSourceLandingAttempt;
  readonly now?: () => number;
}): Promise<BranchRefRoundSourceLandingReceipt> {
  const ref = selectedBranchRef(input.attempt.branch);
  const selectedHead = await resolveCommit(input.git, input.repoRoot, ref);
  const checkedOutAt = await checkedOutWorktreeForBranch(input.git, input.repoRoot, ref);
  if (selectedHead === input.attempt.workerHead) {
    if (checkedOutAt !== null) {
      const checkoutHead = await resolveCommit(input.git, checkedOutAt, "HEAD");
      if (checkoutHead !== input.attempt.workerHead) {
        throw new RoundBranchLandingConflictError(
          `branch ${input.attempt.branch} advanced but its checkout at ${checkedOutAt} stayed on ${checkoutHead}`,
        );
      }
      if (input.attempt.workerHead !== input.attempt.expectedHead) {
        try {
          await input.git(checkedOutAt, [
            "read-tree",
            "-m",
            "-u",
            input.attempt.expectedHead,
            input.attempt.workerHead,
          ]);
        } catch (error) {
          throw new RoundBranchLandingConflictError(
            `branch ${input.attempt.branch} advanced but its checkout at ${checkedOutAt} could not adopt the landed tree: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
    return {
      ...input.attempt,
      outcome:
        input.attempt.workerHead === input.attempt.expectedHead ? "unchanged" : "already-applied",
      landedAt: (input.now ?? Date.now)(),
    };
  }
  if (selectedHead !== input.attempt.expectedHead) {
    throw new RoundBranchLandingConflictError(
      `branch ${input.attempt.branch} moved from ${input.attempt.expectedHead} to ${selectedHead}`,
    );
  }
  if (checkedOutAt !== null) {
    const checkoutHead = await resolveCommit(input.git, checkedOutAt, "HEAD");
    if (checkoutHead !== input.attempt.expectedHead) {
      throw new RoundBranchLandingConflictError(
        `branch ${input.attempt.branch} checkout at ${checkedOutAt} moved to ${checkoutHead}`,
      );
    }
    try {
      await input.git(checkedOutAt, [
        "merge",
        "--ff-only",
        "--no-autostash",
        input.attempt.workerHead,
      ]);
    } catch (error) {
      throw new RoundBranchLandingConflictError(
        `branch ${input.attempt.branch} could not fast-forward its checkout at ${checkedOutAt}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  } else {
    try {
      await input.git(input.repoRoot, [
        "update-ref",
        ref,
        input.attempt.workerHead,
        input.attempt.expectedHead,
      ]);
    } catch (error) {
      throw new RoundBranchLandingConflictError(
        `branch ${input.attempt.branch} could not advance from ${input.attempt.expectedHead}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return { ...input.attempt, outcome: "applied", landedAt: (input.now ?? Date.now)() };
}

export async function releaseRoundSourceCommit(input: {
  readonly git: GitExec;
  readonly repoRoot: string;
  readonly operationId: string;
  readonly commit: string;
}): Promise<{ readonly released: boolean }> {
  const ref = roundSourceRef(input.operationId);
  const existing = await readOptionalObject(input.git, input.repoRoot, ref);
  if (existing === null) return { released: false };
  const expected = await resolveCommit(input.git, input.repoRoot, input.commit);
  if (existing !== expected) throw new RoundSourceRefMismatchError(ref);
  await input.git(input.repoRoot, ["update-ref", "-d", ref, expected]);
  return { released: true };
}

function observedNxProjectCount(output: string): number | undefined {
  let observed: number | undefined;
  for (const line of stripShellControl(output).split(/\r?\n/)) {
    const match = line.match(
      /^\s*NX\s+(?:Successfully ran|Running) targets?\b.*?\bfor (?:(\d+) projects?\b|project\b)/,
    );
    if (match === null) continue;
    const value = match[1];
    observed = value === undefined ? 1 : Number.parseInt(value, 10);
  }
  return observed;
}

interface RoundGateExecutionBase {
  readonly executionId: string;
  readonly command: string;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly durationMs: number;
  readonly projectCount?: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type RoundGateExecution =
  | (RoundGateExecutionBase & { readonly outcome: "passed"; readonly exitCode: 0 })
  | (RoundGateExecutionBase & {
      readonly outcome: "failed";
      readonly termination: RoundTermination;
    });

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message.trim()
    : "gate process could not start";
}

export async function runConfiguredRoundGate(input: {
  readonly locus: Locus;
  readonly cwd: string;
  readonly command: string;
  readonly executionId: string;
  readonly startedAt: number;
  readonly now?: () => number;
  readonly run?: RoundProcessExec;
}): Promise<RoundGateExecution> {
  const now = input.now ?? Date.now;
  const run = input.run ?? execaRoundProcess;
  try {
    const result = await run(locusCommand(input.locus, "sh", ["-lc", input.command], input.cwd));
    const completedAt = now();
    const projectCount = observedNxProjectCount(result.combinedOutput);
    const base = {
      executionId: input.executionId,
      command: input.command,
      startedAt: input.startedAt,
      completedAt,
      durationMs: Math.max(0, completedAt - input.startedAt),
      ...(projectCount === undefined ? {} : { projectCount }),
      stdout: result.stdout,
      stderr: result.stderr,
    };
    if (result.exitCode === 0) return { ...base, outcome: "passed", exitCode: 0 };
    const termination: RoundTermination =
      result.signal !== undefined
        ? { kind: "signal", signal: result.signal }
        : result.exitCode !== null
          ? { kind: "exit", exitCode: result.exitCode }
          : {
              kind: "error",
              reason: result.stderr.trim() || "gate process exited without a code",
            };
    return { ...base, outcome: "failed", termination };
  } catch (error) {
    const completedAt = now();
    return {
      executionId: input.executionId,
      command: input.command,
      startedAt: input.startedAt,
      completedAt,
      durationMs: Math.max(0, completedAt - input.startedAt),
      stdout: "",
      stderr: "",
      outcome: "failed",
      termination: { kind: "error", reason: errorMessage(error) },
    };
  }
}

export interface RoundCommitSettlement {
  readonly executionId: string;
  readonly baseHead: string;
  readonly startedAt: number;
  readonly from: string;
  readonly to: string;
  readonly count: number;
  readonly committedAt: number;
  readonly durationMs: number;
}

export async function settleRoundCommits(input: {
  readonly git: GitExec;
  readonly worktreePath: string;
  readonly executionId: string;
  readonly baseHead: string;
  readonly startedAt: number;
  readonly now?: () => number;
}): Promise<RoundCommitSettlement> {
  const now = input.now ?? Date.now;
  const baseHead = await resolveCommit(input.git, input.worktreePath, input.baseHead);
  let head = await resolveCommit(input.git, input.worktreePath, "HEAD");
  await assertAncestor(input.git, input.worktreePath, baseHead, head);

  const dirty = await input.git(input.worktreePath, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (dirty.length > 0) {
    await input.git(input.worktreePath, ["add", "-A"]);
    await input.git(input.worktreePath, ["commit", "-m", ROUND_COMMIT_MESSAGE]);
    head = await resolveCommit(input.git, input.worktreePath, "HEAD");
    await assertAncestor(input.git, input.worktreePath, baseHead, head);
  }

  const countText = (
    await input.git(input.worktreePath, ["rev-list", "--count", `${baseHead}..${head}`])
  ).trim();
  if (!/^\d+$/.test(countText))
    throw new Error(`Git returned an invalid round commit count: ${countText}`);
  const committedAt = now();
  return {
    executionId: input.executionId,
    baseHead,
    startedAt: input.startedAt,
    from: baseHead,
    to: head,
    count: Number.parseInt(countText, 10),
    committedAt,
    durationMs: Math.max(0, committedAt - input.startedAt),
  };
}

interface RoundLandingResultBase {
  readonly baselineCommit: string;
  readonly workerHead: string;
  readonly changedPaths: readonly string[];
}

export type RoundLandingResult =
  | (RoundLandingResultBase & { readonly outcome: "unchanged"; readonly applied: false })
  | (RoundLandingResultBase & { readonly outcome: "applied"; readonly applied: true })
  | (RoundLandingResultBase & { readonly outcome: "already-applied"; readonly applied: false });

export async function landRoundChanges(input: {
  readonly git: GitExec;
  readonly locus: Locus;
  readonly sourceRoot: string;
  readonly worktreePath: string;
  readonly baselineCommit: string;
  readonly workerHead: string;
  readonly run?: RoundProcessExec;
}): Promise<RoundLandingResult> {
  const run = input.run ?? execaRoundProcess;
  const baselineCommit = await resolveCommit(input.git, input.worktreePath, input.baselineCommit);
  const workerHead = await resolveCommit(input.git, input.worktreePath, input.workerHead);
  await assertAncestor(input.git, input.worktreePath, baselineCommit, workerHead);
  const [patch, changedPathsOutput] = await Promise.all([
    input.git(input.worktreePath, [
      "diff",
      "--binary",
      "--full-index",
      `${baselineCommit}..${workerHead}`,
    ]),
    input.git(input.worktreePath, [
      "diff",
      "--name-only",
      "-z",
      `${baselineCommit}..${workerHead}`,
    ]),
  ]);
  const changedPaths = changedPathsOutput.split("\0").filter((path) => path.length > 0);
  if (patch.length === 0) {
    return { outcome: "unchanged", applied: false, baselineCommit, workerHead, changedPaths };
  }

  const check = await run(
    locusCommand(input.locus, "git", ["apply", "--check", "-"], input.sourceRoot),
    patch,
  );
  if (check.exitCode !== 0) {
    const reverseCheck = await run(
      locusCommand(input.locus, "git", ["apply", "--reverse", "--check", "-"], input.sourceRoot),
      patch,
    );
    if (reverseCheck.exitCode === 0) {
      return {
        outcome: "already-applied",
        applied: false,
        baselineCommit,
        workerHead,
        changedPaths,
      };
    }
    throw new RoundLandingConflictError(
      check.stderr.trim() || `git apply --check exited ${check.exitCode ?? "without a code"}`,
    );
  }
  const applied = await run(
    locusCommand(input.locus, "git", ["apply", "-"], input.sourceRoot),
    patch,
  );
  if (applied.exitCode !== 0) {
    throw new RoundLandingConflictError(
      applied.stderr.trim() || `git apply exited ${applied.exitCode ?? "without a code"}`,
    );
  }
  return { outcome: "applied", applied: true, baselineCommit, workerHead, changedPaths };
}
