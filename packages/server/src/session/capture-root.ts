import type { Project } from "@rennet/protocol";

/**
 * WHICH working-tree root a session-start capture runs in for the clicked row.
 *
 * A row carries an `owner/name` identity and never a path (R19), and a workspace
 * maps MANY repo roots to ONE project identity — the mapping is not invertible.
 * When the identity resolves, that root is the answer. When it does NOT resolve —
 * a stale identity, or one minted before the field existed — substituting the
 * project's default root (`openPath`, which is only "the FIRST included repo") is
 * safe ONLY when the project has at most one included repo. With two or more, the
 * substitution silently captures the WRONG repository under the right row's label:
 * the many-repos-one-identity trap, internally coherent and pointed at the wrong
 * repo.
 *
 * So there we refuse loud rather than guess — the caller rejects before the mint,
 * the row stays clickable, and nothing is claimed. The count keys on
 * `includedRepoPaths` (the repos the user actually included), NOT on `openPath`/
 * `path`, which are the DEFAULT target rather than additional repos. A legacy
 * project stored before `includedRepoPaths` existed has it absent — treated as
 * single-repo, so its rows keep falling back exactly as before.
 *
 * `resolvedRoot` is `repoRootForIdentity`'s answer for `targetRepository`:
 * `undefined` on a miss, and `undefined` when the row names no repository at all
 * (the Current Checkout row, which IS the project as a whole and takes the
 * default root).
 */
export function resolveCaptureRoot(
  project: Project | undefined,
  targetRepository: string | undefined,
  resolvedRoot: string | undefined,
): { readonly root: string } | { readonly error: string } {
  const projectRoot = project?.openPath || project?.path || "";
  if (targetRepository === undefined) return { root: projectRoot };
  if (resolvedRoot !== undefined) return { root: resolvedRoot };
  if (new Set(project?.includedRepoPaths ?? []).size <= 1) return { root: projectRoot };
  return {
    error: `Could not resolve repository ${targetRepository} among the project's included repositories; refusing to guess which one the row named.`,
  };
}
