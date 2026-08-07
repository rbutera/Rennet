import type { GitExec } from "./git-range-diff";

/**
 * Map a GitHub repo onto a local clone by REPO IDENTITY, never a path guess
 * (GitHub Integration Plan §2). The workspace model keys review state on repo
 * identity + changeset, so "is this repo on disk" is a lookup from the PR's
 * `owner/name` onto the discovered worktree set's remote identities — not a guess
 * that a directory named `widget` is `acme/widget`.
 */

/** A forge repo identity parsed out of a git remote URL. */
export interface RemoteIdentity {
  host: string;
  owner: string;
  name: string;
}

/** A discovered local worktree and the forge identities its remotes point at. */
export interface LocalWorktree {
  root: string;
  commonDir: string;
  identities: RemoteIdentity[];
}

/**
 * Parse a git remote URL into a forge identity, or null for a non-forge remote.
 * Handles `https://host/owner/name(.git)`, scp-style `git@host:owner/name(.git)`,
 * and `ssh://git@host/owner/name(.git)`.
 */
export function parseRemoteIdentity(url: string): RemoteIdentity | null {
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;

  const strip = (value: string): string => value.replace(/\.git$/, "");

  // scp-style: git@github.com:owner/name(.git)
  const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(trimmed);
  if (scp) {
    const host = scp[1];
    const rest = strip(scp[2] ?? "");
    const parts = rest.split("/").filter(Boolean);
    if (host && parts.length >= 2) {
      return { host, owner: parts[parts.length - 2] ?? "", name: parts[parts.length - 1] ?? "" };
    }
    return null;
  }

  // URL forms: https://, ssh://, git://
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      const parts = strip(parsed.pathname).split("/").filter(Boolean);
      if (parsed.hostname && parts.length >= 2) {
        return {
          host: parsed.hostname,
          owner: parts[parts.length - 2] ?? "",
          name: parts[parts.length - 1] ?? "",
        };
      }
    } catch {
      return null;
    }
  }

  return null;
}

/** Parse the `key\turl (fetch|push)` lines of `git remote -v` into deduped identities. */
function identitiesFromRemoteVerbose(output: string): RemoteIdentity[] {
  const seen = new Set<string>();
  const identities: RemoteIdentity[] = [];
  for (const line of output.split("\n")) {
    const match = /^\S+\t(\S+)\s+\((?:fetch|push)\)$/.exec(line.trim());
    if (!match) continue;
    const identity = parseRemoteIdentity(match[1] ?? "");
    if (!identity) continue;
    const key = `${identity.host}/${identity.owner}/${identity.name}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    identities.push(identity);
  }
  return identities;
}

/** Discover the remote identities of a single worktree root via injected git. */
export async function discoverWorktreeIdentities(
  git: GitExec,
  root: string,
): Promise<LocalWorktree> {
  const commonDir = (await git(root, ["rev-parse", "--git-common-dir"])).trim();
  const remotes = await git(root, ["remote", "-v"]);
  return { root, commonDir, identities: identitiesFromRemoteVerbose(remotes) };
}

/**
 * Match a PR's repo onto a discovered worktree by identity (owner/name,
 * case-insensitive). Returns null when nothing matches — the caller then takes the
 * degraded REST-diff path. It NEVER falls back to a path-name guess.
 */
export function matchWorktree(
  repo: { owner: string; name: string },
  worktrees: readonly LocalWorktree[],
): LocalWorktree | null {
  const owner = repo.owner.toLowerCase();
  const name = repo.name.toLowerCase();
  for (const worktree of worktrees) {
    for (const identity of worktree.identities) {
      if (identity.owner.toLowerCase() === owner && identity.name.toLowerCase() === name) {
        return worktree;
      }
    }
  }
  return null;
}
