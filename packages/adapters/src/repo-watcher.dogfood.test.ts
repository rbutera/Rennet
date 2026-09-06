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
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const after = openDescriptors();

      // It really is the cheap backend, named rather than inferred from a number that a
      // watcher which failed to arm would also produce.
      expect(watcher.backend()).toBe("recursive");
      expect(watcher.watchedPaths()).toEqual([repoRoot]);

      // THE claim, on the real tree that cost the installed daemon 5,125 file descriptors:
      // watching the whole of it now costs a constant. The old backend misses this bound by
      // three orders of magnitude.
      expect(after - before).toBeLessThan(16);

      // …for the WHOLE tree, not a pruned part of it. Truncation is the honest-degradation
      // path, and on this backend there is nothing to truncate.
      expect(watcher.isTruncated()).toBe(false);

      // Cheap is worth nothing if it does not work. A write three directories deep in this
      // repository is reported, which also proves the one recursive watch reaches past the
      // root it was armed on.
      watcher.setDirty(false);
      expect(watcher.isDirty()).toBe(false);
      writeFileSync(watchedProbe, "probe\n");
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(watcher.isDirty()).toBe(true);

      // And this repository's OWN ignore rules still hold — applied to events now rather
      // than to a walk. Whatever git says this checkout ignores, writing there is silent.
      watcher.setDirty(false);
      expect(watcher.isDirty()).toBe(false);
      writeFileSync(ignoredProbe as string, "probe\n");
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(watcher.isDirty()).toBe(false);
    } finally {
      await watcher.close();
      rmSync(watchedProbe, { force: true });
      if (ignoredProbe !== undefined) rmSync(ignoredProbe, { force: true });
    }
  }, 60_000);
});
