// The land action (workspace-settings D4): fast-forward the checkout holding the reviewed
// branch to the branch the session's work is actually on.
//
// This is the one place `workspace: own` writes to the reviewer's own tree, and everything
// about it is deliberately narrow. It runs on the reviewer's click and nothing else. It
// runs INSIDE the worktree that has the branch checked out — found by asking git, never
// assumed to be the repository root, because the reviewer's checkout of `feat/x` may itself
// be a linked worktree. It is `merge --ff-only`, so git refuses rather than composing a
// merge commit on the reviewer's behalf. And when git refuses, the refusal comes back
// VERBATIM and nothing has changed: no `--force`, no stash, no "shall I?" dialog, and the
// action stays offered so the reviewer can commit their work and click again (Rule Zero —
// a refusal git itself returns is a fact to show, not a gate to build).

import { worktreeForBranch } from "@rennet/adapters";
import type { Locus } from "@rennet/core";
import { WORKTREE_REFUSAL_CAP } from "@rennet/protocol";
import { inRepoSpelling } from "./bound-workspace";

/** `git(cwd, args)` — the locus-aware exec the daemon builds per repository. */
type GitExec = (cwd: string, args: string[], options?: { reject?: boolean }) => Promise<string>;

export type LandWorkBranchOutcome =
  | { status: "landed"; branch: string; workBranch: string; headOid: string }
  | { status: "refused"; branch: string; workBranch: string; reason: string }
  | { status: "unavailable"; reason: string };

/** A declared byte bound with an honest truncation marker (CLAUDE.md, byte discipline). */
function capText(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}… (truncated)` : text;
}

/**
 * Git's own words for a refusal. `stderr` first, because that is where `merge --ff-only`
 * puts "Not possible to fast-forward, aborting." and "Your local changes to the following
 * files would be overwritten by merge"; `stdout` next, because git prints some refusals
 * there; the error's message last, for a runner that carries neither.
 */
function refusalText(error: unknown): string {
  const shaped = error as { stderr?: unknown; stdout?: unknown } | null;
  const parts = [shaped?.stderr, shaped?.stdout]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .map((part) => part.trim());
  const message =
    parts.length > 0 ? parts.join("\n") : error instanceof Error ? error.message : String(error);
  return capText(message, WORKTREE_REFUSAL_CAP);
}

/**
 * Fast-forward `branch` onto `workBranch`, in the worktree that has `branch` checked out.
 *
 * `unavailable` is not a failure: it is what there is to say when the session commits on
 * the reviewed branch itself (nothing to land — the commits are already there), or when no
 * worktree has that branch out any more (the reviewer removed it, or checked something else
 * out). Neither is git refusing anything, so neither reads as one.
 *
 * Every ref is FULLY QUALIFIED. `git merge rennet/feat/x` resolves `refs/tags/` before
 * `refs/heads/`, so a tag of that name — which `git tag rennet/feat/x` creates by accident
 * as easily as on purpose — would silently fast-forward the reviewer's branch to a commit
 * the sibling has nothing to do with.
 */
export async function landWorkBranch(input: {
  readonly git: GitExec;
  readonly repoRoot: string;
  readonly locus: Locus;
  readonly branch: string;
  /** Absent, or equal to `branch`, ⇒ the work is already on the branch: nothing to land. */
  readonly workBranch?: string;
}): Promise<LandWorkBranchOutcome> {
  const { git, repoRoot, branch, workBranch } = input;
  if (workBranch === undefined || workBranch === branch) {
    return { status: "unavailable", reason: `this session's work is on ${branch} already` };
  }
  const checkout = await worktreeForBranch(git, repoRoot, branch);
  if (checkout === undefined) {
    return { status: "unavailable", reason: `no worktree has ${branch} checked out` };
  }
  // Git printed that path; the daemon may address the repository by another spelling (a
  // Windows daemon driving a WSL distro). Run git where git can find it.
  const cwd = inRepoSpelling(checkout, repoRoot, input.locus);
  try {
    await git(cwd, ["merge", "--ff-only", `refs/heads/${workBranch}`], { reject: true });
  } catch (error) {
    return { status: "refused", branch, workBranch, reason: refusalText(error) };
  }
  const headOid = (await git(cwd, ["rev-parse", `refs/heads/${branch}`])).trim();
  return { status: "landed", branch, workBranch, headOid };
}
