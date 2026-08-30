import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execa } from "execa";

/**
 * Clone-on-demand (issue #225): the managed blobless clone store.
 *
 * Opening a PR no longer requires the user to have (or find) a local clone. When no
 * matching clone is supplied, MAIN resolves `<dataDir>/clones/<owner>/<name>` —
 * creating it on first use with `git clone --filter=blob:none`, so full commit/tree
 * history is present (OID pinning, range diffs and snapshot overlays all work) while
 * blobs are fetched lazily by git as they are read. Clones are retained until the
 * user deletes them (worktree/clone management UI is #423); reviews re-open cheaply
 * against the pinned OIDs already in the store.
 *
 * Auth: the clone uses the plain https remote, so git's own credential helper
 * supplies credentials exactly as it would for the user's manual clone. Rennet's
 * GitHub token store is NOT threaded into git.
 * ponytail: ambient-credential clones fail for a private repo with no helper
 * configured; thread the token via a credential shim if that proves common.
 */

/** Where managed clones live under the app data dir. */
export function managedCloneRoot(
  dataDir: string,
  repo: { forge?: string; owner: string; name: string },
): string {
  return repo.forge === undefined || repo.forge === "github"
    ? join(dataDir, "clones", repo.owner, repo.name)
    : join(dataDir, "clones", repo.forge, repo.owner, repo.name);
}

function cloneUrl(repo: { forge?: string; owner: string; name: string }): string {
  const host = repo.forge === "gitlab" ? "gitlab.com" : "github.com";
  return `https://${host}/${repo.owner}/${repo.name}.git`;
}

// One clone per target directory at a time: concurrent opens of the same repo await
// the same clone instead of racing `git clone` into one directory.
const inFlightClones = new Map<string, Promise<string>>();

/**
 * Ensure the managed clone for a forge repo exists and return its root. An existing
 * directory is reused as-is — the PR open path fetches any missing reviewed OIDs
 * itself, so no general `git fetch` runs here.
 */
export async function ensureManagedClone(
  dataDir: string,
  repo: { forge?: string; owner: string; name: string },
  runClone: (url: string, dir: string) => Promise<void> = async (url, dir) => {
    await execa("git", ["clone", "--filter=blob:none", url, dir], { shell: false });
  },
): Promise<string> {
  const dir = managedCloneRoot(dataDir, repo);
  if (existsSync(join(dir, ".git"))) return dir;
  const pending = inFlightClones.get(dir);
  if (pending) return pending;
  const clone = (async () => {
    await mkdir(dirname(dir), { recursive: true });
    try {
      await runClone(cloneUrl(repo), dir);
    } catch (error) {
      throw new Error(
        `Could not clone ${repo.owner}/${repo.name} (${error instanceof Error ? error.message : String(error)}). ` +
          "Pick a local clone of the repository instead.",
        { cause: error },
      );
    }
    return dir;
  })();
  inFlightClones.set(dir, clone);
  try {
    return await clone;
  } finally {
    inFlightClones.delete(dir);
  }
}
