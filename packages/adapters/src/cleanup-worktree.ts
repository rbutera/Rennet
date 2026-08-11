import type { GitExec } from "./git-range-diff";

/**
 * The merged-PR row's clean-up (issue #37, wave B2), for real.
 *
 * B1 shipped `cleanupWorktreeFixture()` — a stub that returned `{ ok: true }` and
 * deleted nothing, a false success. This is the real local git op: `git worktree
 * remove <path>`. It is deliberately NON-forcing — a worktree with uncommitted
 * changes is refused by git, we surface `ok: false`, and the renderer restores the
 * row rather than silently destroying unsaved work (Rule 76 spirit: never discard a
 * change you did not make). The `worktreeId` the boundary carries is the worktree
 * PATH (`LocalWork.id` for a checked-out branch), which is exactly `git worktree
 * remove`'s target.
 *
 * SCOPE: removes the worktree only. Deleting the underlying local branch is a
 * further destructive act whose name is not on this boundary; it is a deferred
 * follow-up. Removing the worktree already reclaims the disk-heavy artifact.
 */
export interface CleanupWorktreeDeps {
  git: GitExec;
  /** The project's main repo root, from which `git worktree remove` is run. */
  resolveProjectRoot(projectId: string): Promise<string | null>;
}

export async function cleanupWorktree(
  deps: CleanupWorktreeDeps,
  input: { projectId: string; worktreeId: string },
): Promise<{ ok: boolean }> {
  const root = await deps.resolveProjectRoot(input.projectId);
  if (!root) return { ok: false };
  try {
    // No `--force`: git refuses a dirty worktree, and that refusal is the guard —
    // uncommitted work is never swept. The renderer restores the annotation on ok:false.
    await deps.git(root, ["worktree", "remove", input.worktreeId], { reject: true });
    return { ok: true };
  } catch {
    // A dirty worktree, a missing path, or a locked worktree: all report honestly as
    // "not cleaned" so the surface never claims a removal that did not happen.
    return { ok: false };
  }
}
