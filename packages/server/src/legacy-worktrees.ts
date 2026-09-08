// The daemon-start sweep of the worktree zoo (session-bound-workspace 5.5).
//
// Earlier versions kept a detached worktree PER ROUND OPERATION under
// `<dataDir>/round-worktrees/<key>` and a detached evidence worktree PER REVIEW under
// `<dataDir>/worktrees/review/<reviewId>`. One session now binds to one workspace and every
// child runs there, so nothing recreates either kind — but a machine that has run Rennet
// before still has them on disk, holding git admin entries their repository has no use for.
//
// Removed ONCE, at start, and only on a positive contradiction: a directory NO live session's
// `boundRoot` names. A session that predates the binding wave records nothing and binds
// lazily on its first use (5.1), which is why "no session names it" is checked against the
// recorded roots rather than against the absence of a session.

import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { comparablePath } from "./bound-workspace";

/** `git(cwd, args)` — the locus-aware exec the daemon already builds per repository. */
type GitExec = (cwd: string, args: string[], options?: { reject?: boolean }) => Promise<string>;

/** The directories a version before the binding wave created, one entry per worktree. */
function legacyWorktreeDirs(dataDir: string): string[] {
  const parents = [join(dataDir, "round-worktrees"), join(dataDir, "worktrees", "review")];
  return parents.flatMap((parent) => {
    try {
      return readdirSync(parent, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(parent, entry.name));
    } catch {
      return []; // this daemon never created that kind, or the directory is unreadable
    }
  });
}

export interface LegacyWorktreeSweepInput {
  readonly dataDir: string;
  /**
   * The bound roots of every LIVE session — a directory any of them names is left alone.
   *
   * Read as a function, and read again immediately before each removal: a session can bind
   * lazily on its first use while this sweep is walking, and a snapshot taken at the start
   * would delete the workspace it just took.
   */
  readonly liveBoundRoots: () => readonly string[];
  /** The daemon's git for a path; the sweep runs `worktree remove` from inside the worktree. */
  readonly gitFor: (root: string) => GitExec;
  readonly log?: (message: string) => void;
}

/**
 * Remove the legacy round and review worktrees no live session is bound to, and say how many.
 *
 * `git worktree remove --force` is issued from INSIDE the worktree, which git accepts and
 * which is the only way to reach the owning repository without knowing where it is: the
 * worktree's own `.git` file points at it, and the removal drops the admin entry with the
 * directory. A directory git will not own (its repository is gone, the `.git` link is broken)
 * is removed outright — leaving it would keep the zoo alive forever for no benefit.
 *
 * ⚠️ AND IT DOES NOT PRUNE. It used to follow the removal with `git worktree prune`, to
 * clear an entry left by a directory somebody had deleted by hand — a repo-wide verb, run
 * against a repository this sweep does not even know the root of, with no idea what else
 * was registered there. `prune` drops every registration git cannot reach RIGHT NOW, and an
 * unmounted volume reads exactly like a deleted directory: the reviewer's own worktree on
 * that volume went with ours. There is now ONE prune site in the daemon, the start-up
 * sweep in `create-server.ts`, which prunes only registrations Rennet placed, only when no
 * live session claims one, and only when every unreachable registration in the repository
 * passes both tests.
 *
 * Nothing is lost by not pruning here. `worktree remove` drops the registration it owns,
 * which is this sweep's ordinary path; a stale entry left by a hand-deleted directory has
 * nothing that would ever re-`add` there (nothing recreates the zoo), and the guarded sweep
 * answers for it on this start or the next.
 *
 * Never throws: a sweep is not allowed to stop a daemon from starting.
 */
export async function sweepLegacyWorktrees(input: LegacyWorktreeSweepInput): Promise<number> {
  let removed = 0;
  for (const dir of legacyWorktreeDirs(input.dataDir)) {
    // Re-read, and compare resolved: the previous removal awaited git, and a session may have
    // bound lazily in that window. `/var/x` and `/private/var/x` are one directory, and a raw
    // string compare would let the exclusion miss it and delete a live session's workspace.
    const bound = new Set(input.liveBoundRoots().map(comparablePath));
    if (bound.has(comparablePath(dir))) continue;
    const git = input.gitFor(dir);
    try {
      // `remove` drops the admin entry it owns, and only that one. No `prune` follows it:
      // see the header — `prune` is repo-wide and belongs to the guarded start-up sweep.
      await git(dir, ["worktree", "remove", "--force", dir], { reject: false });
    } catch {
      // git could not speak for this directory; the filesystem removal below still stands.
    }
    try {
      rmSync(dir, { recursive: true, force: true });
      removed += 1;
    } catch {
      // A directory we cannot remove is left for the next start, never fatal.
    }
  }
  if (removed > 0) {
    (input.log ?? console.info)(
      `rennet: removed ${removed} retired round/review worktree${removed === 1 ? "" : "s"}`,
    );
  }
  return removed;
}
