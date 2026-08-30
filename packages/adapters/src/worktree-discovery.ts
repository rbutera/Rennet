import type { ForgeRepoIdentity } from "@rennet/protocol";
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

/** Provider id for a remote host. Unknown self-hosted forges remain host-qualified. */
export function forgeForRemoteHost(host: string): string {
  const normalized = host.toLowerCase();
  return normalized === "github.com"
    ? "github"
    : normalized === "gitlab.com"
      ? "gitlab"
      : normalized === "bitbucket.org"
        ? "bitbucket"
        : normalized;
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
      return {
        host,
        owner: parts.slice(0, -1).join("/"),
        name: parts[parts.length - 1] ?? "",
      };
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
          owner: parts.slice(0, -1).join("/"),
          name: parts[parts.length - 1] ?? "",
        };
      }
    } catch {
      return null;
    }
  }

  return null;
}

function remoteIdentityKey(identity: RemoteIdentity): string {
  return `${identity.host}/${identity.owner}/${identity.name}`.toLowerCase();
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
    const key = remoteIdentityKey(identity);
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

/** A named git remote that points at a forge repo (the name + its parsed identity). */
export interface NamedForgeRemote {
  /** The git remote name (`origin`, `upstream`, …) — the ref to push to. */
  name: string;
  identity: RemoteIdentity;
}

interface NamedRemoteCandidates {
  name: string;
  fetchIdentities: Map<string, RemoteIdentity>;
  pushIdentities: Map<string, RemoteIdentity>;
  sawPush: boolean;
  invalidPush: boolean;
}

/**
 * Parse `git remote -v` into named forge remotes in first-seen order. A configured
 * push URL owns the identity because `git push <name>` uses it; fetch is only the
 * fallback for partial output without a push line. Ambiguous or unparseable push
 * destinations cannot supply the single identity shared by push and submission.
 */
function namedForgeRemotesFromVerbose(output: string): NamedForgeRemote[] {
  const candidates = new Map<string, NamedRemoteCandidates>();
  for (const line of output.split("\n")) {
    const match = /^(\S+)\t(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
    if (!match) continue;
    const name = match[1] ?? "";
    const identity = parseRemoteIdentity(match[2] ?? "");
    const direction = match[3];
    let candidate = candidates.get(name);
    if (!candidate) {
      candidate = {
        name,
        fetchIdentities: new Map(),
        pushIdentities: new Map(),
        sawPush: false,
        invalidPush: false,
      };
      candidates.set(name, candidate);
    }
    if (direction === "push") {
      candidate.sawPush = true;
      if (!identity) {
        candidate.invalidPush = true;
      } else {
        candidate.pushIdentities.set(remoteIdentityKey(identity), identity);
      }
    } else if (direction === "fetch" && identity) {
      candidate.fetchIdentities.set(remoteIdentityKey(identity), identity);
    }
  }

  const remotes: NamedForgeRemote[] = [];
  for (const candidate of candidates.values()) {
    if (candidate.sawPush && candidate.invalidPush) continue;
    const identities = candidate.sawPush ? candidate.pushIdentities : candidate.fetchIdentities;
    if (identities.size !== 1) continue;
    const identity = identities.values().next().value;
    if (!identity) continue;
    remotes.push({ name: candidate.name, identity });
  }
  return remotes;
}

/**
 * Resolve the ONE remote a branch is pushed to AND its PR opened against, so the push
 * destination and the PR repo can never disagree (they share a single source). Picks
 * the remote whose provider is supported by the caller, preferring one named
 * `preferName` (default `origin` — the North Star: your own repo), else the first such
 * remote in `git remote -v` order. Without a provider predicate, `host` retains the
 * original GitHub-only default. Returns null when no remote points at a supported forge —
 * the caller then reports honestly that there is nowhere to open a PR.
 */
export async function resolveForgeRemote(
  git: GitExec,
  root: string,
  options: {
    host?: string;
    preferName?: string;
    supportsForge?: (forge: string) => boolean;
  } = {},
): Promise<NamedForgeRemote | null> {
  const host = options.host?.toLowerCase() ?? (options.supportsForge ? undefined : "github.com");
  const preferName = options.preferName ?? "origin";
  const remotes = namedForgeRemotesFromVerbose(await git(root, ["remote", "-v"])).filter(
    (remote) =>
      (host === undefined || remote.identity.host.toLowerCase() === host) &&
      (options.supportsForge?.(forgeForRemoteHost(remote.identity.host)) ?? true),
  );
  return remotes.find((remote) => remote.name === preferName) ?? remotes[0] ?? null;
}

/**
 * Match a PR's repo onto a discovered worktree by provider-qualified identity
 * (forge + owner/name, case-insensitive). Returns null when nothing matches — the
 * caller then takes the degraded REST-diff path. It NEVER falls back to a path-name guess.
 */
export function matchWorktree(
  repo: ForgeRepoIdentity,
  worktrees: readonly LocalWorktree[],
): LocalWorktree | null {
  const forge = repo.forge.toLowerCase();
  const owner = repo.owner.toLowerCase();
  const name = repo.name.toLowerCase();
  for (const worktree of worktrees) {
    for (const identity of worktree.identities) {
      if (
        forgeForRemoteHost(identity.host) === forge &&
        identity.owner.toLowerCase() === owner &&
        identity.name.toLowerCase() === name
      ) {
        return worktree;
      }
    }
  }
  return null;
}
