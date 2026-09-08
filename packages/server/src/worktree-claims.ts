// WHO IS WORKING IN THIS WORKTREE — one answer, for the three places that act on it
// (workspace-settings D4/D5).
//
// Three callers decide three destructive things from this one fact:
//
//   • the daemon-start PRUNE guard, which drops a repository's unreachable registrations;
//   • the sibling COLLECTION, which removes a worktree and deletes its branch;
//   • the BRANCH BIND, which puts a worktree Rennet placed and nothing claims back on the
//     branch under review after something checked another ref out inside it.
//
// They used to each carry their own predicate, and two of them disagreed: the prune asked by
// work branch and by path, the collection asked by path alone, so a session claiming its
// sibling by work branch alone had its registration spared by the prune two lines up and its
// BRANCH DELETED by the collection (review finding F3). One factory, three callers, and the
// disagreement has nowhere left to live.
//
// Keyed BY REPOSITORY, always. A workspace project maps many repositories onto one identity
// and that mapping is not invertible: `rennet/main` can exist in two repositories of one
// project, and a claim resolved from the project would answer for whichever the mapping
// happened to yield (CLAUDE.md, 2026-08-28).

import type { WorktreeClaim, WorktreeRecord } from "@rennet/adapters";
import type { Locus } from "@rennet/core";
import { comparablePath, inRepoSpelling } from "./bound-workspace";

/** The three fields of a session a claim is made of. Structural, and generic below, so the
 *  daemon passes its `SessionModel` and a test passes three fields — rather than a test
 *  having to mint a whole session record to ask a question about two strings. */
export interface ClaimingSession {
  readonly id: string;
  readonly boundRoot?: string;
  readonly workBranch?: string;
}

export interface WorktreeClaimsInput<S extends ClaimingSession> {
  /** The LIVE sessions — archived ones claim nothing. The caller filters, because it also
   *  decides how fresh the list is: the sweep reads it once per pass, a bind reads it now. */
  readonly sessions: readonly S[];
  /** The repository these registrations belong to. */
  readonly repoRoot: string;
  /** That repository's execution locus, which decides how git's own paths are spelled. */
  readonly locus: Locus;
  /** A session's repository, from its own record or its review — never from a project id. */
  readonly repositoryRootOf: (session: S) => string | undefined;
}

/**
 * The claim oracle for ONE repository's worktree registrations.
 *
 * Asked TWO ways, either sufficient, and the answer NAMES the session so a refusal can say
 * who is working there rather than leaving the reviewer to guess:
 *
 * By WORK BRANCH, in this repository: the session record's own statement of what it is
 * committing on, which needs no path at all — the claim that survives a session whose
 * recorded spelling does not match git's.
 *
 * By PATH, in BOTH spellings — git's (the record's own) and the daemon's, through
 * `inRepoSpelling`, which is the WSL arrangement where the two genuinely differ. And
 * `comparablePath` on each, which for a MISSING directory — and an unreachable registration
 * is exactly that — resolves the deepest ancestor that still exists and re-attaches the
 * tail. That last part is not a nicety: Codex reproduced the prune of a claimed registration
 * on macOS, where git prints `/private/var/…` and the daemon records the `/var/…` symlink,
 * and plain `realpath` refuses both because the directory is gone.
 *
 * ⚠️ ASYMMETRIC ABOUT AN UNKNOWN REPOSITORY, AND DELIBERATELY THE OTHER WAY FROM A MATCHER'S.
 * A session whose repository cannot be determined counts as a claimant of its work branch
 * everywhere. The usual rule is "match on a positive contradiction, never on silence",
 * because excluding on silence loses rows; what excluding on silence costs HERE is somebody's
 * working tree — a pruned registration, a deleted branch, or a workspace checked out from
 * under a live session.
 *
 * The resulting predicate is PURE and synchronous: no git, no filesystem write, one
 * `comparablePath` per candidate. Callers ask it once per registration inside a loop.
 */
export function worktreeClaimsIn<S extends ClaimingSession>(
  input: WorktreeClaimsInput<S>,
): (record: WorktreeRecord) => WorktreeClaim {
  const { sessions, repoRoot, locus, repositoryRootOf } = input;
  const here = comparablePath(repoRoot);
  /** The work branches live sessions OF THIS REPOSITORY are committing on, each with the
   *  first session that claimed it — first because a refusal names one session, and the
   *  oldest claimant is the one whose workspace this has been for longest. */
  const byBranch = new Map<string, string>();
  /** Every spelling of every live session's bound root, whatever repository it is in: a path
   *  that git listed as a worktree of THIS repository and a session records is a claim on it
   *  by identity, and no repository test can make it not one. */
  const byPath = new Map<string, string>();
  for (const session of sessions) {
    if (session.workBranch !== undefined) {
      const sessionRoot = repositoryRootOf(session);
      if (sessionRoot === undefined || comparablePath(sessionRoot) === here) {
        if (!byBranch.has(session.workBranch)) byBranch.set(session.workBranch, session.id);
      }
    }
    if (session.boundRoot !== undefined) {
      for (const spelling of [session.boundRoot, comparablePath(session.boundRoot)]) {
        if (!byPath.has(spelling)) byPath.set(spelling, session.id);
      }
    }
  }
  return (record: WorktreeRecord): WorktreeClaim => {
    const onBranch = record.branch === undefined ? undefined : byBranch.get(record.branch);
    if (onBranch !== undefined) return { sessionId: onBranch };
    for (const path of [record.path, inRepoSpelling(record.path, repoRoot, locus)]) {
      const claimant = byPath.get(path) ?? byPath.get(comparablePath(path));
      if (claimant !== undefined) return { sessionId: claimant };
    }
    return false;
  };
}
