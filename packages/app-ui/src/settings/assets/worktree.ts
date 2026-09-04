// ─────────────────────────────────────────────────────────────────────────────
// The client defaults for the served per-project worktree prefs.
//
// The naming tokens and the folder-name preview that used to live here are GONE (#812):
// nothing places a worktree from a pattern. A session binds to the checkout that already
// has its branch out, or to `branchWorktreePath(dataDir, repoKey, branch)` — the
// repository's escaped path, then the branch as path segments — so a `{project}-{branch}`
// preview described a folder Rennet never creates. Settings → Projects → Worktrees now
// states the binding instead of offering to configure it.
//
// The two values below remain the client's read of an UNSET pref (`live-projection`
// carries the layer the resolver reported, never a fabricated one).
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_WORKTREE_ROOT = "~/.rennet/worktrees";
export const DEFAULT_WORKTREE_PATTERN = "{project}-{branch}";
