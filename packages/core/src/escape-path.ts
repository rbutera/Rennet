/**
 * `escapePath` — the escaped-absolute-path scheme for the local-first Repo Map
 * store (#141 / R55, decisions 1 & 2; design §1.2). It flattens a repository's
 * canonical absolute path into ONE cross-platform-safe directory segment, so
 * `~/.rennet/projects/<escapePath(top-level)>/` names a project by where it lives
 * on disk — mirroring Claude Code's session-dir convention (`~/.claude/projects/
 * -Users-rai-navi`), and replacing wave-1's opaque `sha256Hex(git-common-dir)`
 * segment. A readable, path-derived key is what lets `relocate`/aliases (§1.5) and
 * a human eyeballing the store both work.
 *
 * NODE-FREE (design §7): this is the pure string transform only. Step (1) of the
 * scheme — "resolve to the canonical absolute path" — is `realpath`, which is node
 * I/O and therefore the CALLER's job (the adapter passes `escapePath(realpathSync(
 * top-level))`, exactly as the RepoRecord resolver does). Keeping the fs hop out of
 * `core` is what keeps the whole novelty/context handler layer node-free. The
 * transform assumes its input is already an absolute, realpath'd path (no `.`/`..`
 * segments, no trailing separator — realpath guarantees this).
 *
 * The scheme (design §1.2 / repo-map-storage spec):
 *   (2) replace every character in `{ '/', '\\', ':' }` with `-`;
 *   (3) collapse any run of consecutive `-` into a single `-`.
 *
 * ⚠️ The transform is intentionally lossy (a `:` and a `/` both map to `-`, and
 * runs collapse), so two DISTINCT canonical paths could in principle collide on
 * one segment. This matches Claude Code's accepted convention; the store treats
 * the escaped segment as the directory key, and a `config.json` inside it records
 * the true path for `relocate` disambiguation.
 */
export function escapePath(absPath: string): string {
  return absPath.replace(/[/\\:]/g, "-").replace(/-{2,}/g, "-");
}
