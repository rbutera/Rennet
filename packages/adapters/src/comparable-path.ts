import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * The form of a path two sides can be COMPARED in: `realpath` where it exists, and the
 * deepest ancestor that does exist plus the literal tail where it does not.
 *
 * It lives in `adapters` rather than beside its first caller because BOTH sides of every
 * registration question need it and they sit in different packages: the daemon's sweep
 * (`create-server.ts`) matches a session's recorded root against `git worktree list`, and
 * the two binds here match a computed placement against the same listing. Two
 * implementations of this comparison is how a sweep and a bind come to disagree about
 * whether one directory is one directory.
 *
 * git prints RESOLVED paths; a computed placement and a session's recorded root carry
 * whatever spelling the settings ladder and the daemon produced. On macOS that is every
 * path under `/var` (`/private/var`) and every default `TMPDIR`, so a raw string compare
 * calls one directory two.
 */
export function comparablePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolveThroughExistingAncestor(path);
  }
}

/**
 * The comparable form of a path that DOES NOT EXIST: the deepest ancestor that does exist,
 * resolved, with the remaining segments re-attached literally.
 *
 * `realpathSync` throws on a missing directory, and the paths this comparison is asked
 * hardest about are exactly the missing ones — an UNREACHABLE worktree registration is a
 * directory that is gone, and the question asked of it is whether a live session's recorded
 * `boundRoot` names it. Returning both sides literally answers "no" for a pair that differs
 * only in a symlinked ancestor, which on macOS is every path under `/var` (`/private/var`)
 * and every default `TMPDIR`. Codex reproduced the consequence: the sweep pruned a
 * registration a live session was bound to, because git had printed the resolved spelling
 * and the session had recorded the daemon's.
 *
 * NOTE what is and is not resolved. The missing directory itself is never `realpath`ed —
 * it cannot be. Only an ancestor that exists is, which is an exact operation, so this never
 * makes two different directories compare equal. A path with no existing ancestor at all
 * (an unreachable UNC root) comes back literal, and still compares equal to itself.
 *
 * `join` NORMALISES THE MISSING TAIL LEXICALLY, so a `..` inside it is collapsed without
 * asking the filesystem — the one place this could differ from `realpath`, which would
 * resolve `a/link/..` to the link's target's parent. No input this is asked about can
 * diverge: a path with a `..` in its missing tail names a directory that is not there, and
 * every REACHABLE path takes the `realpathSync` branch above and is never lexically
 * normalised at all. The tail is compared, not opened.
 */
function resolveThroughExistingAncestor(path: string): string {
  const tail: string[] = [];
  let current = path;
  for (;;) {
    const parent = dirname(current);
    if (parent === current) return path; // reached the root without finding anything
    tail.unshift(basename(current));
    try {
      return join(realpathSync(parent), ...tail);
    } catch {
      current = parent;
    }
  }
}
