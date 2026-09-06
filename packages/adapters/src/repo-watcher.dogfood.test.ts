// The watcher, on the real rennet checkout — the only place #850 and #892 were visible.
//
// A hermetic fixture can assert that git's ignore rules are honoured, but it cannot know
// what THIS repository ignores, and that was the whole of #850: the watcher filtered on a
// hardcoded `.git`/`.nx`/`node_modules` list, and every other gitignored tree in the
// checkout — `.claude/worktrees/`, `.pnpm-store/`, every `dist/` — was walked and watched.
//
// #892 is the sequel, and the reason this file changed shape. Honouring git's rules brought
// this checkout from 36,142 wanted watches down to ~6,000, and chokidar's Node backend
// still spends ONE DESCRIPTOR PER FILE, so ~6,000 is what the daemon paid: `lsof` on the
// installed 0.9.1 daemon showed 5,147 open descriptors, 5,125 of them regular files under
// this checkout, and 41,887 `EMFILE … watch` lines in `~/.rennet/daemon.log`. No bound could
// save it — the bound was derived from `process.report`'s soft limit, and that number reads
// 1,048,575 on every Mac. So the backend changed instead: one recursive watch for the tree.
//
// Which makes this suite's question different, and better. It is no longer "did the walk
// prune enough of the real tree" — there is no walk — it is "on the real repository, with
// its real ignore rules, does this cost a constant and still see a change". It reads the
// live checkout, so its verdict depends on state no Nx input can hash: hence
// `*.dogfood.test.ts`, run by the uncacheable `dogfood-test` target.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { RepoWatcher } from "./repo-watcher";

/** This process's REAL open descriptors, from the kernel rather than from any counter. */
function openDescriptors(): number {
  return readdirSync(process.platform === "linux" ? "/proc/self/fd" : "/dev/fd").length;
}

/**
 * Wait until the watcher will vouch for the tree, up to `budget` ms.
 *
 * Not a convenience. The two backends earn trust at different moments and the difference is
 * enormous on a real checkout: the recursive one is trustworthy in the tick it is created,
 * while the per-entry one waits for chokidar to finish walking this repository, which is
 * seconds. Asserting a clear after a fixed sleep therefore tested the machine, not the
 * watcher — CI failed here as `expected true to be false` before this existed.
 *
 * It is still a real assertion: a watcher that never becomes trustworthy returns false, and
 * every caller asserts on that.
 */
async function waitForClean(
  watcher: { isDirty(): boolean; setDirty(value: boolean): void },
  budget = 30_000,
): Promise<boolean> {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    watcher.setDirty(false);
    if (!watcher.isDirty()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  watcher.setDirty(false);
  return !watcher.isDirty();
}

/** Poll until the watcher reports a change, up to `budget` ms. */
async function waitForDirty(watcher: { isDirty(): boolean }, budget = 15_000): Promise<boolean> {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    if (watcher.isDirty()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return watcher.isDirty();
}

/** True when git itself ignores `path` — asked of git, not of the watcher under test. */
function gitIgnores(repoRoot: string, path: string): boolean {
  try {
    execFileSync("git", ["-C", repoRoot, "check-ignore", "-q", relative(repoRoot, path)], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

describe("RepoWatcher — dogfood over the REAL rennet checkout (#850, #892)", () => {
  const repoRoot = join(import.meta.dirname, "../../..");

  it("watches this whole repository for a constant number of descriptors, and still sees an edit", async () => {
    // git's own answer, asked independently of the watcher: every directory this checkout
    // ignores, whatever put it there (`.gitignore`, a nested one, the global excludesFile,
    // `.git/info/exclude`). On Rai's machine this list contains `.claude/worktrees/`; in CI
    // it contains `node_modules/`, `.nx/` and every `dist/`.
    const ignoredDirectories = execFileSync(
      "git",
      [
        "-C",
        repoRoot,
        "ls-files",
        "-z",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
        "--no-empty-directory",
      ],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    )
      .split("\0")
      .filter((entry) => entry.endsWith("/"));

    // Non-vacuous: a checkout with nothing ignored would make the silence assertion below
    // pass by having nothing to catch. A built checkout always has `node_modules/`.
    expect(ignoredDirectories.length).toBeGreaterThan(0);

    // Both probes are files this test creates and removes. Nothing tracked is written to —
    // a dogfood suite that edited the source tree would be restoring from HEAD over
    // whatever the developer had uncommitted.
    const ignoredProbe = ignoredDirectories
      .map((directory) => join(repoRoot, directory, ".rennet-watch-dogfood-probe"))
      .find((path) => existsSync(join(path, "..")));
    const watchedProbe = join(repoRoot, "packages/adapters/src/.rennet-watch-dogfood-probe");
    expect(ignoredProbe).toBeDefined();
    // The premise of each half, asked of git rather than assumed: one path git ignores and
    // one it does not. Without this the two opposite assertions below could both be about
    // the same kind of path.
    expect(gitIgnores(repoRoot, ignoredProbe as string)).toBe(true);
    expect(gitIgnores(repoRoot, watchedProbe)).toBe(false);

    const watcher = new RepoWatcher();
    const before = openDescriptors();
    try {
      watcher.start(repoRoot);
      // Wait for the watcher to become trustworthy rather than for a fixed sleep, then
      // measure. On the recursive backend this returns immediately; on the per-entry one it
      // is the whole initial walk of this checkout, and measuring before it finished would
      // read a descriptor count that is still climbing.
      expect(await waitForClean(watcher)).toBe(true);
      const after = openDescriptors();

      // The backend this platform actually selects, named rather than inferred from a
      // number that a watcher which failed to arm would also produce. macOS and Windows get
      // the kernel's recursive watch — one watched path for the whole checkout. Linux has no
      // recursive watch in the kernel (Node's is userland and arms one per ENTRY, measured
      // in CI at 1,204 handles for 1,200 files), so it keeps the pruning per-entry backend,
      // and there the interesting property is that it mapped the tree without entering what
      // git ignores. Rennet ships no Linux desktop; this is the in-WSL daemon's platform.
      if (process.platform === "darwin" || process.platform === "win32") {
        expect(watcher.backend()).toBe("recursive");
        expect(watcher.watchedPaths()).toEqual([repoRoot]);
      } else {
        expect(watcher.backend()).toBe("per-entry");
        expect(watcher.watchedPaths().length).toBeGreaterThan(500);
      }

      // THE claim, on the real tree that cost the installed daemon 5,125 file descriptors:
      // watching the whole of it costs a handful. Asserted only where the recursive backend
      // runs, because that is where it has been measured and where the bug was. On Linux the
      // per-entry backend's cost is inotify watches rather than descriptors, and inventing a
      // descriptor bound for it would be the same mistake in miniature.
      if (watcher.backend() === "recursive") {
        expect(after - before).toBeLessThan(16);
      }

      // …for the WHOLE tree, not a pruned part of it. Truncation is the honest-degradation
      // path, and on this backend there is nothing to truncate.
      expect(watcher.isTruncated()).toBe(false);

      // Cheap is worth nothing if it does not work. A write three directories deep in this
      // repository is reported, which also proves the watch reaches past the root.
      expect(await waitForClean(watcher)).toBe(true);
      writeFileSync(watchedProbe, "probe\n");
      expect(await waitForDirty(watcher)).toBe(true);

      // And this repository's OWN ignore rules still hold. Whatever git says this checkout
      // ignores, writing there is silent — filtered from the events on the recursive
      // backend, never walked into on the per-entry one.
      expect(await waitForClean(watcher)).toBe(true);
      writeFileSync(ignoredProbe as string, "probe\n");
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(watcher.isDirty()).toBe(false);
    } finally {
      await watcher.close();
      rmSync(watchedProbe, { force: true });
      if (ignoredProbe !== undefined) rmSync(ignoredProbe, { force: true });
    }
  }, 60_000);
});
