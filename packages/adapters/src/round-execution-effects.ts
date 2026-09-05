import { LocusDistroMismatchError } from "@rennet/core";
import type { GitExec } from "./git-range-diff";

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
