// The watcher, on the real rennet checkout — the only place #850 was visible.
//
// A hermetic fixture can assert that git's ignore rules are honoured, but it cannot know
// what THIS repository ignores, and that is the whole defect: the watcher filtered on a
// hardcoded `.git`/`.nx`/`node_modules` list, and every other gitignored tree in the
// checkout — `.claude/worktrees/`, `.pnpm-store/`, every `dist/` — was walked and watched.
// chokidar arms one `fs.watch` per file, so on Rai's machine that was 19,896 open
// descriptors, 13,438 of them under `.claude/worktrees/`, and after that every `spawn`
// failed `EBADF`: the T3 sidecar died and took all five lens lanes with it.
//
// So this suite reads the live checkout, which makes its verdict depend on state no Nx
// input can hash — hence `*.dogfood.test.ts`, excluded from the cacheable `test` target
// and run by the uncacheable `dogfood-test` one (see packages/adapters/project.json).
//
// It is cheap: the fix under test is what makes it cheap. Watching this repository with
// its ignore rules honoured is a few thousand descriptors and about a second.

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RepoWatcher, watchBudget } from "./repo-watcher";

describe("RepoWatcher — dogfood over the REAL rennet checkout (#850)", () => {
  const repoRoot = join(import.meta.dirname, "../../..");

  it("watches this repository inside its descriptor budget and enters none of its gitignored trees", async () => {
    // git's own answer, asked independently of the watcher: every directory this
    // checkout ignores, whatever put it there (`.gitignore`, a nested one, the global
    // excludesFile, `.git/info/exclude`). On Rai's machine this list contains
    // `.claude/worktrees/`; in CI it contains `node_modules/`, `.nx/` and every `dist/`.
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

    // Non-vacuous: a checkout with nothing ignored would make every assertion below pass
    // by having nothing to catch. A built checkout always has `node_modules/` at least.
    expect(ignoredDirectories.length).toBeGreaterThan(0);

    const watcher = new RepoWatcher();
    try {
      watcher.start(repoRoot);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      const watched = watcher.watchedPaths();

      // It really mapped the source tree — this repository tracks ~4,700 files, and a
      // watcher that had failed or been pruned to nothing would satisfy the bound below.
      expect(watched.length).toBeGreaterThan(500);
      // …and stayed inside its share of the process's descriptors, which is the property
      // #850 violated by a factor of two and a half.
      expect(watched.length).toBeLessThan(watchBudget());
      expect(watcher.isTruncated()).toBe(false);

      // Nothing git calls ignored is watched. Named individually rather than counted, so
      // a bound met by dropping the wrong subtree still fails.
      const offenders = watched.filter((path) => {
        const relative = path.slice(repoRoot.length + 1);
        return ignoredDirectories.some((directory) => relative.startsWith(directory));
      });
      expect(offenders.slice(0, 10)).toEqual([]);

      // The reviewer's own file is watched, which is what the watcher is for.
      expect(watched.some((path) => path.endsWith("packages/adapters/src/repo-watcher.ts"))).toBe(
        true,
      );
    } finally {
      await watcher.close();
    }
  }, 60_000);
});
