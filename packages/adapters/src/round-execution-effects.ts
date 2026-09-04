import {
  type Locus,
  LocusDistroMismatchError,
  locusCommand,
  stripShellControl,
} from "@rennet/core";
import type { RoundTermination } from "@rennet/protocol";
import { execa } from "execa";
import type { GitExec } from "./git-range-diff";

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

export class RoundBaseHeadNotAncestorError extends Error {
  override readonly name = "RoundBaseHeadNotAncestorError";

  constructor(
    readonly baseHead: string,
    readonly head: string,
  ) {
    super(`Round base ${baseHead} is not an ancestor of ${head}`);
  }
}

async function resolveCommit(git: GitExec, root: string, value: string): Promise<string> {
  return (await git(root, ["rev-parse", "--verify", `${value}^{commit}`])).trim();
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

/**
 * OBSERVE the commits the round's turn left on the bound root's branch. Nothing is staged
 * and nothing is committed: the worker commits its own work (the work order asks it to),
 * and Rennet never runs `git add -A` on the reviewer's behalf in their own checkout
 * (session-bound-workspace: "SHALL NOT stage untracked files with a blanket add"). A turn
 * that changed files without committing them reads as zero commits, honestly, and the
 * coordinator's worker/commit agreement check turns that into a failed round rather than a
 * silent commit of whatever else was lying in the tree.
 */
export async function observeRoundCommits(input: {
  readonly git: GitExec;
  readonly root: string;
  readonly executionId: string;
  readonly baseHead: string;
  readonly startedAt: number;
  readonly now?: () => number;
}): Promise<RoundCommitSettlement> {
  const now = input.now ?? Date.now;
  const baseHead = await resolveCommit(input.git, input.root, input.baseHead);
  const head = await resolveCommit(input.git, input.root, "HEAD");
  await assertAncestor(input.git, input.root, baseHead, head);
  const countText = (
    await input.git(input.root, ["rev-list", "--count", `${baseHead}..${head}`])
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
