import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { FsEntry, FsListDirResult } from "@rennet/protocol";

export interface FsListDirDeps {
  homedir(): string;
  readEntries(dir: string): Promise<readonly { name: string; isDirectory: boolean }[]>;
  hasGitEntry(dir: string): Promise<boolean>;
}

export function defaultFsListDirDeps(): FsListDirDeps {
  return {
    homedir,
    async readEntries(dir) {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
    },
    async hasGitEntry(dir) {
      // Read the child dir to look for `.git`. Do NOT swallow a read failure into
      // `false` (that mislabels a permission-denied child as a readable non-repo, and
      // makes `listDir`'s `unreadable` branch unreachable): let it throw so `listDir`
      // flags the child `unreadable` instead.
      return (await readdir(dir)).includes(".git");
    },
  };
}

/**
 * The ungated filesystem browser behind `fs.listDir` (Rule Zero: this is the
 * browser, not a gated reader). Directories only, hidden included, name-sorted;
 * `.git` presence flags `isRepo`; a per-entry read failure never throws, it just
 * flags `unreadable`. Empty/omitted path defaults to the daemon's home dir;
 * `parent` is null at the filesystem root.
 */
export async function listDir(
  input: { path?: string },
  deps: FsListDirDeps,
): Promise<FsListDirResult> {
  const home = deps.homedir();
  const path = input.path && input.path.length > 0 ? input.path : home;
  // A failure to read the TARGET dir (nonexistent / permission-denied path) is a real
  // fault, not an empty directory — let it propagate so the RPC rejects and the browser
  // shows an inline error with Continue DISABLED (SPEC: invalid typed path), instead of
  // an empty "No folders here" success on a bad path. Per-ENTRY faults stay soft below.
  const dirs = (await deps.readEntries(path)).filter((e) => e.isDirectory);
  const entries: FsEntry[] = await Promise.all(
    [...dirs]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (e) => {
        const childPath = join(path, e.name);
        let isRepo = false;
        let unreadable = false;
        try {
          isRepo = await deps.hasGitEntry(childPath);
        } catch {
          unreadable = true;
        }
        return { name: e.name, path: childPath, isRepo, unreadable };
      }),
  );
  const parent = dirname(path);
  return { path, home, parent: parent === path ? null : parent, entries };
}
