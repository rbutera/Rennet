import { describe, expect, it, vi } from "vitest";
import { filesystemIgnoresCase, isIgnoredPath, readGitIgnoredEntries } from "./repo-watcher";

/**
 * Poll until the watcher reports a change, up to `budget` ms.
 *
 * Every "a change WAS reported" assertion in this file goes through here rather than
 * through a fixed sleep. A fixed sleep is not a weaker assertion, it is a FLAKIER one: this
 * suite passed on its own and failed inside `pnpm check`, where thirteen other projects'
 * tests are competing for the same cores and an FSEvents flush arrives late. A test that
 * reddens on machine load is a test whose red means nothing.
 *
 * It is still a real assertion — the helper returns false if the change never arrives, and
 * every caller asserts on that. Only the "stayed SILENT" checks keep a fixed window, because
 * absence can only be observed by waiting a fixed time.
 */
async function waitForDirty(watcher: { isDirty(): boolean }, budget = 6_000): Promise<boolean> {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    if (watcher.isDirty()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return watcher.isDirty();
}

describe("isIgnoredPath (add-windows-support: both separator flavours)", () => {
  it("ignores .git on POSIX paths", () => {
    expect(isIgnoredPath("/repo", "/repo/.git/HEAD")).toBe(true);
  });

  it("ignores .git on Windows/UNC paths (backslashes)", () => {
    expect(
      isIgnoredPath(
        "\\\\wsl.localhost\\Ubuntu\\home\\rai\\repo",
        "\\\\wsl.localhost\\Ubuntu\\home\\rai\\repo\\.git\\HEAD",
      ),
    ).toBe(true);
    expect(isIgnoredPath("C:\\dev\\repo", "C:\\dev\\repo\\.git\\HEAD")).toBe(true);
  });

  // #729, D6: the watcher used to ignore ALL of `.rennet`, which is a superset of what
  // capture excludes — so a tracked `.rennet/conventions.json` edit changed the captured
  // patchset while the watcher stayed silent about it. Now the two agree exactly: the
  // app-owned board prefix and nothing else.
  it("ignores the app-owned board prefix, in either separator flavour", () => {
    expect(isIgnoredPath("/repo", "/repo/.rennet/boards/board-1.jsonl")).toBe(true);
    // The directory entry itself, so chokidar prunes before descending.
    expect(isIgnoredPath("/repo", "/repo/.rennet/boards")).toBe(true);
    expect(isIgnoredPath("C:\\dev\\repo", "C:\\dev\\repo\\.rennet\\boards\\board-1.jsonl")).toBe(
      true,
    );
    expect(
      isIgnoredPath(
        "\\\\wsl.localhost\\Ubuntu\\home\\rai\\repo",
        "\\\\wsl.localhost\\Ubuntu\\home\\rai\\repo\\.rennet\\boards\\board-1.jsonl",
      ),
    ).toBe(true);
  });

  // Native Windows holds a root like `C:/dev/repo` while chokidar reports
  // `C:\dev\repo\…`. A byte-for-byte prefix test made every one of those events look
  // like it came from outside the repository, so a board write Rennet made marked the
  // tree dirty and cost a recapture that could only ever find nothing.
  it("relativizes one root across separator spellings, and case where Windows folds it", () => {
    expect(isIgnoredPath("C:/dev/repo", "C:\\dev\\repo\\.rennet\\boards\\b.jsonl")).toBe(true);
    expect(isIgnoredPath("C:\\dev\\repo", "C:/dev/repo/.rennet/boards/b.jsonl")).toBe(true);
    // A drive letter or UNC share the daemon and chokidar spell differently.
    expect(
      isIgnoredPath("c:/dev/repo", "C:\\dev\\repo\\.rennet\\boards\\b.jsonl", { ignoreCase: true }),
    ).toBe(true);
    // …and normalizing separators must not smear one root into its sibling.
    expect(isIgnoredPath("C:/dev/repo", "C:\\dev\\repo-2\\.rennet\\boards\\b.jsonl")).toBe(false);
    expect(isIgnoredPath("C:/dev/repo", "C:\\dev\\repo-2\\src\\app.ts")).toBe(false);
  });

  // The macOS default. An existing `.Rennet/Boards/` IS `.rennet/boards/` there, so the
  // board writer's lowercase join lands inside it and every event arrives spelled the
  // alias's way. Where the filesystem does distinguish them the alias is a second,
  // genuinely different directory that Rennet never writes to — so it stays watched.
  it("ignores a case-aliased board directory only where the filesystem folds case", () => {
    expect(isIgnoredPath("/repo", "/repo/.Rennet/Boards/b.jsonl", { ignoreCase: true })).toBe(true);
    expect(isIgnoredPath("/repo", "/repo/.rennet/BOARDS", { ignoreCase: true })).toBe(true);
    expect(isIgnoredPath("/repo", "/repo/.Rennet/Boards/b.jsonl")).toBe(false);
    // The prefix boundary survives the fold: this is still the user's directory.
    expect(
      isIgnoredPath("/repo", "/repo/.Rennet/Boards-extra/notes.md", { ignoreCase: true }),
    ).toBe(false);
  });

  // Capture asks git (`core.ignoreCase`) and the watcher probes the filesystem, because
  // for a WSL project they address different filesystems and `start` cannot await a
  // `git config`. Two probes of one property have to agree, or capture excludes a path
  // the watcher reports and freshness contradicts the patchset — the defect #729 is.
  it("agrees with git's own core.ignoreCase probe on this filesystem", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "rennet-repo-watcher-case-"));
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, stdio: "ignore" });
      const git = execFileSync(
        "git",
        ["config", "--type=bool", "--default=false", "--get", "core.ignoreCase"],
        { cwd: root, encoding: "utf8" },
      ).trim();
      expect(filesystemIgnoresCase(root)).toBe(git === "true");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("watches the rest of .rennet — it is the user's project content, and it captures", () => {
    // Tracked house rules: capture keeps them, so an edit has to invalidate.
    expect(isIgnoredPath("/repo", "/repo/.rennet/conventions.json")).toBe(false);
    expect(isIgnoredPath("C:\\dev\\repo", "C:\\dev\\repo\\.rennet\\conventions.json")).toBe(false);
    // The prefix boundary: a directory that merely starts with the same letters.
    expect(isIgnoredPath("/repo", "/repo/.rennet/boards-extra/notes.md")).toBe(false);
    expect(isIgnoredPath("C:\\dev\\repo", "C:\\dev\\repo\\.rennet\\boards-extra\\notes.md")).toBe(
      false,
    );
    // Ownership is anchored at the ROOT: a vendored checkout's own board directory is
    // the user's, because Rennet never writes there.
    expect(isIgnoredPath("/repo", "/repo/vendor/pkg/.rennet/boards/b.jsonl")).toBe(false);
  });

  // `.nx` is gitignored, so it can never enter a capture, and on this repository it is
  // 4,877 of 23,549 entries — a fifth of the walk, for nothing. Pruning it took the initial
  // walk from ~64s to ~900ms and 4,176–4,779 EMFILE failures to zero.
  it("ignores .nx — a fifth of this repo's tree, and git can never show it", () => {
    expect(isIgnoredPath("/repo", "/repo/.nx/workspace-data/d.db")).toBe(true);
    expect(isIgnoredPath("/repo", "/repo/.nx")).toBe(true);
    expect(isIgnoredPath("C:\\dev\\repo", "C:\\dev\\repo\\.nx\\workspace-data\\d.db")).toBe(true);
    // Not a prefix match: a real source directory whose name merely starts with it stays.
    expect(isIgnoredPath("/repo", "/repo/src/.nxrc/config.ts")).toBe(false);
  });

  it("ignores node_modules — the 9P poll storm's source (contents and the dir itself)", () => {
    expect(isIgnoredPath("/repo", "/repo/node_modules/foo/index.js")).toBe(true);
    expect(
      isIgnoredPath(
        "\\\\wsl.localhost\\Ubuntu\\home\\rai\\repo",
        "\\\\wsl.localhost\\Ubuntu\\home\\rai\\repo\\node_modules\\.bin\\semver",
      ),
    ).toBe(true);
    // The directory entry itself must match so chokidar prunes before descending.
    expect(isIgnoredPath("/repo", "/repo/node_modules")).toBe(true);
    expect(isIgnoredPath("C:\\dev\\repo", "C:\\dev\\repo\\node_modules")).toBe(true);
  });

  it("does not ignore ordinary source files", () => {
    expect(isIgnoredPath("/repo", "/repo/src/app.ts")).toBe(false);
    expect(isIgnoredPath("C:\\dev\\repo", "C:\\dev\\repo\\src\\app.ts")).toBe(false);
    // A file whose name merely starts with an ignored segment is not ignored.
    expect(isIgnoredPath("/repo", "/repo/src/node_modules_helper.ts")).toBe(false);
  });
});

// The daemon crash-loop fix (lancelot, 2026-08-19): a watcher "error" event —
// e.g. a spurious EISDIR lstat over the \\wsl.localhost 9P bridge — must be
// consumed, never left to crash the process, and WSL UNC roots must poll.
describe("RepoWatcher hardening", () => {
  it("survives a watcher error event instead of crashing the process", async () => {
    const { RepoWatcher } = await import("./repo-watcher");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "rennet-repo-watcher-"));
    const watcher = new RepoWatcher();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      watcher.start(root);
      const inner = (watcher as unknown as { watcher: { emit(e: string, x: unknown): void } })
        .watcher;
      // Unhandled, this emit would throw (EventEmitter "error" semantics).
      expect(() =>
        inner.emit(
          "error",
          Object.assign(new Error("EISDIR: illegal operation"), {
            code: "EISDIR",
          }),
        ),
      ).not.toThrow();
      expect(quiet).toHaveBeenCalled();
    } finally {
      quiet.mockRestore();
      await watcher.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Re-`start` on the same root must NOT rebuild the watcher (#576 review, finding B).
  // `review.load` calls `startWatching` on every open, and the freshness ask re-reads it on
  // every window focus — a rebuild per alt-tab would re-walk the tree, and with
  // `ignoreInitial: true` every edit landing in that window is silently dropped: a review
  // that went stale and never says so.
  it("keeps the live watcher when re-started on the same root, and rebuilds for a new one", async () => {
    const { RepoWatcher } = await import("./repo-watcher");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const first = mkdtempSync(join(tmpdir(), "rennet-repo-watcher-a-"));
    const second = mkdtempSync(join(tmpdir(), "rennet-repo-watcher-b-"));
    const watcher = new RepoWatcher();
    const inner = () => (watcher as unknown as { watcher: unknown }).watcher;
    try {
      watcher.start(first);
      const original = inner();
      expect(original).not.toBeNull();

      watcher.start(first);
      expect(inner()).toBe(original); // same root ⇒ the SAME chokidar instance, never re-walked

      watcher.start(second);
      const swapped = inner();
      expect(swapped).not.toBe(original); // a different root is a real re-watch

      // …and the swap must SURVIVE the teardown finishing. `start` does not await
      // `close`, so a `close` that released its fields after its own await would land a
      // microtask later and null out the watcher just installed — orphaning a live
      // chokidar instance and, worse, making the same-root check above miss, so the next
      // `review.load` re-walks the tree and re-opens the #601 first-save window.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(inner()).toBe(swapped);
      watcher.start(second);
      expect(inner()).toBe(swapped); // still the same root ⇒ still a no-op
    } finally {
      await watcher.close();
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  // #601 — the first save after a fresh capture, and READ THE REASON, because it changed
  // with #892 and the old one no longer applies.
  //
  // Under the chokidar backend this test passed by REFUSING TO VOUCH. chokidar armed its
  // watches file by file as it walked, `ignoreInitial: true` suppressed everything it met on
  // the way, and a save landing before the walk reached that file was never reported at all
  // — measured at 0 of 20 runs on this very fixture. So the watcher had to keep saying
  // "dirty" until its walk finished, and the assertion below held because the flag was
  // pinned on, not because the save was seen.
  //
  // Under the recursive backend it passes because the save is GENUINELY REPORTED. One
  // `fs.watch(root, { recursive: true })` arms in the tick it is created: the same-tick write
  // this test issues was reported in 20 of 20 measured runs. The window is closed rather than
  // survived, which is why the second half — an untouched tree clearing and STAYING clear —
  // is the load-bearing half now. Without it, a watcher that simply never cleared would pass
  // the first assertion perfectly, which is exactly what the old backend did.
  //
  // The tree is 400 files over eight directories, kept from the original so the two backends
  // are measured on the same fixture.
  it("reports a save that lands in the same tick as the watch, and clears once nothing moves", async () => {
    const { RepoWatcher } = await import("./repo-watcher");
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { setTimeout: sleep } = await import("node:timers/promises");
    const root = mkdtempSync(join(tmpdir(), "rennet-repo-watcher-first-save-"));
    for (let i = 0; i < 400; i += 1) {
      const dir = join(root, `d${Math.floor(i / 50)}`);
      if (i % 50 === 0) mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `f${i}.ts`), `export const value = ${i};\n`);
    }
    const edited = join(root, "d0", "f0.ts");
    const watcher = new RepoWatcher();
    try {
      // The order `review.capture` uses: pin the review to the tree as it stands, then
      // put the watcher on the root.
      watcher.setDirty(false);
      watcher.start(root);
      // The renderer asks about freshness as soon as the review is on screen — on a real
      // repository the walk is still running seconds later, so this ask lands inside it.
      // It finds nothing (nothing has happened yet) and clears the flag. THIS is the step
      // that loses the next save: a clear taken on the word of a watcher that has not
      // finished looking.
      watcher.setDirty(false);
      // The reviewer's first save, landing inside the walk. chokidar will never mention it.
      writeFileSync(edited, "export const value = 999;\n");
      // The recursive watch was armed before the write landed, so this is a reported
      // change, not a pinned flag. Under the old backend this write did not exist as far
      // as the watcher was concerned and the assertion held on `!settled` instead.
      expect(await waitForDirty(watcher)).toBe(true);

      // And the flag is not merely pinned on. A watcher that cried stale forever would
      // satisfy the assertion above while being useless, so: once the walk has finished
      // and the ask has cleared, an untouched tree answers "unchanged".
      watcher.setDirty(false);
      await sleep(300);
      expect(watcher.isDirty()).toBe(false);

      // A later save — the ordinary, always-worked path — is still reported.
      writeFileSync(edited, "export const value = 1000;\n");
      expect(await waitForDirty(watcher)).toBe(true);
    } finally {
      await watcher.close();
      rmSync(root, { recursive: true, force: true });
    }
    // Above vitest's 5s default: `waitForDirty` alone may spend 6s, and under a full
    // `pnpm check` — thirteen other projects on the same cores — it has needed most of it.
  }, 30_000);

  // #729 through the real filesystem: Rennet writing its own board must not mark the
  // reviewer's tree dirty, and the same watcher must still report the file beside it.
  // The two halves are one run on purpose — a watcher that reported nothing at all
  // would satisfy the first assertion perfectly.
  it("stays quiet for app-owned board writes and still reports the file beside them", async () => {
    const { RepoWatcher } = await import("./repo-watcher");
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { setTimeout: sleep } = await import("node:timers/promises");
    const root = mkdtempSync(join(tmpdir(), "rennet-repo-watcher-app-owned-"));
    // The project content that lives under `.rennet` and belongs to the user, present
    // before the watch is armed so the writes below are modifications, not arrivals.
    mkdirSync(join(root, ".rennet", "boards-extra"), { recursive: true });
    writeFileSync(join(root, ".rennet", "conventions.json"), '{"rules":[]}\n');
    writeFileSync(join(root, ".rennet", "boards-extra", "notes.md"), "mine\n");
    writeFileSync(join(root, "src.ts"), "export const value = 1;\n");
    const watcher = new RepoWatcher();
    try {
      watcher.start(root);
      // Wait for the initial walk, then clear — a clear only sticks once chokidar has
      // finished looking (#601), so this is also what proves the walk is done.
      await sleep(500);
      watcher.setDirty(false);
      expect(watcher.isDirty()).toBe(false);

      // Rennet writes a board, exactly where `createBoardsRuntime` roots the store.
      mkdirSync(join(root, ".rennet", "boards"), { recursive: true });
      writeFileSync(join(root, ".rennet", "boards", "board-1.jsonl"), '{"seq":1}\n');
      await sleep(700);
      expect(watcher.isDirty()).toBe(false);

      // The prefix boundary and the tracked house rules are the user's, and both are in
      // the capture — so both have to be reported.
      writeFileSync(join(root, ".rennet", "boards-extra", "notes.md"), "mine, edited\n");
      expect(await waitForDirty(watcher)).toBe(true);

      watcher.setDirty(false);
      writeFileSync(join(root, ".rennet", "conventions.json"), '{"rules":["one"]}\n');
      expect(await waitForDirty(watcher)).toBe(true);
    } finally {
      await watcher.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  // The macOS shape, through the real chokidar. A `.Rennet/Boards/` directory already
  // exists; the board writer's lowercase join lands INSIDE it, because on this filesystem
  // they are one directory — and chokidar reports the spelling that is on disk, not the
  // one Rennet asked for. So the predicate is handed `.Rennet/Boards/board-1.jsonl`, and
  // only a `start` that probed the filesystem and passed the answer down ignores it.
  //
  // Writing through `.Rennet/Boards` into a lowercase directory proves nothing: chokidar
  // still reports the lowercase path and the assertion holds with the probe removed. It
  // has to be the alias that is on disk. (A case-sensitive filesystem has no alias to
  // build, so this test states that and stops rather than passing vacuously.)
  it("stays quiet for a board write that lands in an existing case-aliased directory", async () => {
    const { RepoWatcher } = await import("./repo-watcher");
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { setTimeout: sleep } = await import("node:timers/promises");
    const root = mkdtempSync(join(tmpdir(), "rennet-repo-watcher-alias-"));
    const watcher = new RepoWatcher();
    try {
      if (!filesystemIgnoresCase(root)) {
        expect(filesystemIgnoresCase(root)).toBe(false); // case-sensitive: no alias exists
        return;
      }
      mkdirSync(join(root, ".Rennet", "Boards"), { recursive: true });
      writeFileSync(join(root, "src.ts"), "export const value = 1;\n");
      watcher.start(root);
      await sleep(500);
      watcher.setDirty(false);
      expect(watcher.isDirty()).toBe(false);

      // `createBoardsRuntime` joins the lowercase segments; this is that write.
      writeFileSync(join(root, ".rennet", "boards", "board-1.jsonl"), '{"seq":1}\n');
      await sleep(700);
      expect(watcher.isDirty()).toBe(false);

      // …and the same watcher still reports the reviewer's own file, so "quiet" above is
      // not a watcher that had stopped reporting anything.
      writeFileSync(join(root, "src.ts"), "export const value = 2;\n");
      expect(await waitForDirty(watcher)).toBe(true);
    } finally {
      await watcher.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("classifies WSL UNC roots so they poll regardless of locus", async () => {
    const { isWslUncPath } = await import("./repo-watcher");
    expect(isWslUncPath("\\\\wsl.localhost\\Ubuntu\\home\\rai\\dev\\x")).toBe(true);
    expect(isWslUncPath("\\\\wsl$\\Ubuntu\\home\\rai\\dev\\x")).toBe(true);
    expect(isWslUncPath("C:\\dev\\repo")).toBe(false);
    expect(isWslUncPath("/home/rai/dev/repo")).toBe(false);
  });
});

// #892 — the cost model. The bug this replaces was NOT a bound set too high: it was a
// bound derived from a number that does not bind. `watchBudget()` was half of
// `process.report`'s `userLimits.open_files.soft`, and on macOS Node raises `RLIMIT_NOFILE`
// towards an unlimited hard limit at startup, so that field reads 1,048,575 on every Mac
// while the kernel enforces `kern.maxfilesperproc` (92,149 measured here) regardless. Half
// of a million is over the ceiling, so the budget was the constant 32,768 on every Mac and
// never once fired: the 0.9.1 daemon log held 41,887 `EMFILE … watch` lines and ZERO
// `watch budget spent` lines.
//
// So these tests do not measure a budget. They measure the RESOURCE — this process's real
// open descriptors, read from the kernel's own `/dev/fd` (or `/proc/self/fd`), plus live
// `fs.watch` handles from `process.getActiveResourcesInfo()`. A test that asserted the
// watcher's own accounting would be exactly the defect under repair, because the accounting
// was never what was wrong.
describe("RepoWatcher descriptor cost (#892)", () => {
  /**
   * Poll until the watcher reports a change, up to `budget` ms. Every "a change WAS
   * reported" assertion in this suite goes through here rather than through a fixed sleep:
   * the first version used 400ms and flaked under load, and a flaky test is a test whose
   * red means nothing.
   */
  async function waitForDirty(watcher: { isDirty(): boolean }, budget = 4_000): Promise<boolean> {
    const deadline = Date.now() + budget;
    while (Date.now() < deadline) {
      if (watcher.isDirty()) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return watcher.isDirty();
  }

  /** Live `fs.watch` handles in this process — the watcher's own libuv handles. */
  function fsWatchHandles(): number {
    return process.getActiveResourcesInfo().filter((resource) => /fsevent/i.test(resource)).length;
  }

  /**
   * This process's REAL open descriptor count, from the kernel rather than from anything
   * Rennet counts. `/proc/self/fd` on Linux, `/dev/fd` on macOS; both list one entry per
   * open descriptor. Reading the directory itself opens one, consistently in both samples,
   * so a delta is exact.
   */
  async function openDescriptors(): Promise<number> {
    const { readdirSync } = await import("node:fs");
    return readdirSync(process.platform === "linux" ? "/proc/self/fd" : "/dev/fd").length;
  }

  /**
   * The same counts, taken once the previous test's handles have actually gone. These are
   * PROCESS-wide measurements, so a baseline read while a sibling watcher is still closing
   * makes the delta wrong on nothing that happened in this test.
   */
  async function settledCounts(): Promise<{ handles: number; descriptors: number }> {
    let previous = -1;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const current = fsWatchHandles();
      if (current === previous) break;
      previous = current;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { handles: fsWatchHandles(), descriptors: await openDescriptors() };
  }

  // THE test. 1,200 files in three directories, nothing ignored, and the watcher must cost
  // a constant. Under the chokidar backend this fixture cost ~1,200 descriptors, because
  // libuv answers `fs.watch` on a non-directory with kqueue and an `open()` — measured
  // directly on this machine: 20,000 file watches cost 20,000 descriptors, and under a
  // 256-descriptor limit exactly 245 watches and 245 plain `open`s succeeded before EMFILE.
  //
  // The shape of the fixture is deliberate: many files, FEW directories. A per-file backend
  // is ~1,200 either way, while every recursive backend — FSEvents on macOS, a recursive
  // ReadDirectoryChangesW on Windows, per-directory inotify watches on one shared descriptor
  // on Linux — is a small constant on all three. So the bound below is lethal to the old
  // cost model on every platform this runs on, not only the one it was measured on.
  it("costs a constant number of descriptors for a tree of any size, and still reports a change", async () => {
    const { RepoWatcher } = await import("./repo-watcher");
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "rennet-repo-watcher-cost-"));
    for (let d = 0; d < 3; d += 1) {
      mkdirSync(join(root, `d${d}`), { recursive: true });
      for (let i = 0; i < 400; i += 1)
        writeFileSync(join(root, `d${d}`, `f${i}.ts`), "export {};\n");
    }
    const watcher = new RepoWatcher();
    const before = await settledCounts();
    try {
      watcher.start(root);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const after = await settledCounts();

      // Non-vacuous, and it has to come first: a watcher that failed to arm would satisfy
      // every bound below by costing nothing. It armed, and this platform's measurement
      // can see it.
      expect(watcher.backend()).toBe("recursive");
      expect(after.handles - before.handles).toBeGreaterThan(0);

      // The claim. 1,200 files, and the cost is a handful of descriptors — not 1,200, and
      // not a number that grows with the tree. This is the assertion the old backend fails
      // by two orders of magnitude.
      expect(after.descriptors - before.descriptors).toBeLessThan(16);
      expect(after.handles - before.handles).toBeLessThan(8);

      // And it is a WORKING watcher at that price, which is the half that stops "cheap"
      // from being satisfied by watching nothing. Nested, because a recursive watch that
      // only covered the root directory would still be cheap and still be wrong.
      watcher.setDirty(false);
      expect(watcher.isDirty()).toBe(false);
      writeFileSync(join(root, "d2", "f399.ts"), "export const changed = 1;\n");
      expect(await waitForDirty(watcher)).toBe(true);

      // …and it never had to give up part of the tree to get there. Truncation is the
      // honest-degradation path; on this backend there is nothing to truncate.
      expect(watcher.isTruncated()).toBe(false);
    } finally {
      await watcher.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  // The ignore rules survive the backend change, at a different seam. They can no longer
  // prune a walk — the kernel watches the subtree whole — so they filter EVENTS instead,
  // through the same `isIgnoredPath` and the same `git ls-files --others --ignored
  // --directory` answer. The fixture is #850's, at a size a test can build, and it exercises
  // four mechanisms a hand-rolled matcher gets wrong: a root `.gitignore`, a NESTED one, a
  // NEGATION re-including a directory its parent excluded, and `.git/info/exclude`.
  //
  // Both halves in one run on purpose: a watcher that reported nothing would pass every
  // "stays quiet" assertion perfectly.
  it("does not go dirty for the gitignored tree beside the one it watches", async () => {
    const { RepoWatcher } = await import("./repo-watcher");
    const { execFileSync } = await import("node:child_process");
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { setTimeout: sleep } = await import("node:timers/promises");
    const root = mkdtempSync(join(tmpdir(), "rennet-repo-watcher-gitignore-"));
    const git = (...args: string[]): void => {
      execFileSync("git", args, { cwd: root, stdio: "ignore" });
    };
    git("init", "-q", "-b", "main");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "user.name", "fixture");

    // Rai's checkout, at a size a test can build: `.claude/*` is this repository's own
    // `.gitignore:62`, and `.claude/worktrees/` under it is the 13,438-file tree of #850.
    writeFileSync(join(root, ".gitignore"), ".claude/*\nvendor/*\n!vendor/keep/\n*.log\ndropme/\n");
    mkdirSync(join(root, "src"), { recursive: true });
    for (let i = 0; i < 12; i += 1) writeFileSync(join(root, "src", `f${i}.ts`), "export {};\n");
    mkdirSync(join(root, ".claude", "worktrees", "lane-a"), { recursive: true });
    for (let i = 0; i < 20; i += 1)
      writeFileSync(join(root, ".claude", "worktrees", "lane-a", `f${i}.ts`), "export {};\n");
    mkdirSync(join(root, "packages", "app", "src"), { recursive: true });
    mkdirSync(join(root, "packages", "app", "build"), { recursive: true });
    writeFileSync(join(root, "packages", "app", ".gitignore"), "build/\n");
    writeFileSync(join(root, "packages", "app", "src", "a.ts"), "export {};\n");
    writeFileSync(join(root, "packages", "app", "build", "b0.js"), "0;\n");
    mkdirSync(join(root, "vendor", "drop"), { recursive: true });
    mkdirSync(join(root, "vendor", "keep"), { recursive: true });
    writeFileSync(join(root, "vendor", "drop", "d0.ts"), "export {};\n");
    writeFileSync(join(root, "vendor", "keep", "k.ts"), "export {};\n");
    mkdirSync(join(root, "scratch"), { recursive: true });
    writeFileSync(join(root, "scratch", "s0.ts"), "export {};\n");
    writeFileSync(join(root, ".git", "info", "exclude"), "scratch/\n");
    writeFileSync(join(root, "notes.log"), "noise\n");
    // Committed, because git's collapsed answer stops at the outermost directory it has
    // no reason to enter — see the last assertion. A repository under review has tracked
    // files by definition.
    git("add", "-A");
    git("commit", "-qm", "fixture");

    const watcher = new RepoWatcher();
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      watcher.start(root);
      await sleep(300);

      // Each ignored tree, written to individually and asserted individually, so a pass
      // bought by ignoring EVERYTHING — which would also keep the reviewer's own edit
      // quiet — cannot hide behind an aggregate.
      const ignoredWrites: ReadonlyArray<readonly [string, string]> = [
        ["root .gitignore", join(root, ".claude", "worktrees", "lane-a", "f0.ts")],
        ["nested .gitignore", join(root, "packages", "app", "build", "b0.js")],
        ["vendor/*", join(root, "vendor", "drop", "d0.ts")],
        [".git/info/exclude", join(root, "scratch", "s0.ts")],
        ["a single ignored file", join(root, "notes.log")],
        [".git itself", join(root, ".git", "rennet-probe")],
      ];
      // Each ignored write gets its own silence window AND its own proof that the window
      // was live: immediately after it, a write git does NOT ignore must be reported. So a
      // "stayed quiet" verdict can never be bought by a watcher that had stopped delivering
      // — the vacuous pass this suite would otherwise be one slow FSEvents flush away from.
      const sentinel = join(root, "src", "sentinel.ts");
      const wentDirty: string[] = [];
      const channelWasDead: string[] = [];
      for (const [why, path] of ignoredWrites) {
        watcher.setDirty(false);
        writeFileSync(path, "touched\n");
        await sleep(600);
        if (watcher.isDirty()) wentDirty.push(why);
        writeFileSync(sentinel, `export const after = "${why}";\n`);
        if (!(await waitForDirty(watcher))) channelWasDead.push(why);
        // Drain the sentinel's stragglers BEFORE the next iteration clears the flag.
        // FSEvents can deliver more than one event for one write, and a duplicate landing
        // inside the next silence window would read as an ignored path going dirty — a red
        // that says the opposite of what happened.
        await sleep(300);
      }
      expect({ wentDirty, channelWasDead }).toEqual({ wentDirty: [], channelWasDead: [] });

      // …and the files git does NOT ignore, including the negation git re-included, are
      // every one of them reported. Same loop shape, opposite verdict.
      const watchedWrites: ReadonlyArray<readonly [string, string]> = [
        ["tracked source", join(root, "src", "f0.ts")],
        ["the negation re-included by !vendor/keep/", join(root, "vendor", "keep", "k.ts")],
        ["a file beside a nested ignore rule", join(root, "packages", "app", "src", "a.ts")],
      ];
      const stayedClean: string[] = [];
      for (const [why, path] of watchedWrites) {
        watcher.setDirty(false);
        writeFileSync(path, "export const changed = 1;\n");
        if (!(await waitForDirty(watcher))) stayedClean.push(why);
      }
      expect(stayedClean).toEqual([]);

      // What this does NOT catch, executed and stated rather than left to be discovered.
      // `git ls-files --directory` collapses at the outermost directory git has no reason
      // to enter, so an ignored subtree inside a WHOLLY UNTRACKED directory is absent from
      // git's answer even though git itself calls it ignored — the two assertions below
      // are that disagreement, run. Under the old backend the budget was what made that
      // survivable; under this one it costs nothing, because an event the rules fail to
      // recognise is a spurious dirty flag and a real diff, not a descriptor.
      mkdirSync(join(root, "untracked", "dropme"), { recursive: true });
      writeFileSync(join(root, "untracked", "dropme", "x.js"), "0;\n");
      expect(readGitIgnoredEntries(root)?.has("untracked/dropme/")).toBe(false);
      expect(
        execFileSync("git", ["check-ignore", "untracked/dropme/x.js"], {
          cwd: root,
          encoding: "utf8",
        }).trim(),
      ).toBe("untracked/dropme/x.js");
    } finally {
      quiet.mockRestore();
      await watcher.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  // The polling backend keeps a cap, and the cap keeps its honest degradation. It is a
  // DIFFERENT bound with a different reason: `fs.watchFile` is a libuv poll timer and holds
  // no descriptor, so what this bounds is `stat` storms over the 9P bridge, not exhaustion.
  // Exercised at 64 entries so the fixture is buildable, and reached through a `wsl` locus
  // because that — not the path — is what selects polling.
  it("stops at its poll cap on the WSL path, and says so instead of failing silently", async () => {
    const { RepoWatcher } = await import("./repo-watcher");
    const { execFileSync } = await import("node:child_process");
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "rennet-repo-watcher-pollcap-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, stdio: "ignore" });
    for (let d = 0; d < 6; d += 1) {
      mkdirSync(join(root, `d${d}`), { recursive: true });
      for (let i = 0; i < 50; i += 1)
        writeFileSync(join(root, `d${d}`, `f${i}.ts`), "export {};\n");
    }

    const watcher = new RepoWatcher({ maxPolledEntries: 64 });
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      watcher.start(root, { kind: "wsl", distro: "Ubuntu" });
      await new Promise((resolve) => setTimeout(resolve, 1_500));

      // The locus, not the path, chose this backend — and it really is the polling one.
      expect(watcher.backend()).toBe("polling");
      // 306 entries exist; the cap is 64.
      expect(watcher.watchedPaths().length).toBeGreaterThan(0);
      expect(watcher.watchedPaths().length).toBeLessThan(80);

      // Honest degradation, which is the half that keeps the daemon usable: the watcher
      // knows it is partial, says which root and how many, and refuses to vouch — so
      // freshness runs a real diff rather than answering "current" from a watcher that
      // is not looking at most of the tree.
      expect(watcher.isTruncated()).toBe(true);
      watcher.setDirty(false);
      expect(watcher.isDirty()).toBe(true);
      const said = warned.mock.calls.map((call) => String(call[0])).join("\n");
      expect(said).toContain("poll cap spent: 64 entries");
      expect(said).toContain(root);
      // Said once for the root, not once per entry.
      expect(said.match(/poll cap spent/g)).toHaveLength(1);
    } finally {
      warned.mockRestore();
      await watcher.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  // A root no watcher can be armed on must not read as a quiet one. There is no fallback to
  // a per-entry watcher — that is the cost model this change removes — so the answer is to
  // stop vouching, which makes every freshness ask run a real diff.
  it("refuses to vouch for a root it could not arm a watch on", async () => {
    const { RepoWatcher } = await import("./repo-watcher");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "rennet-repo-watcher-unarmable-"));
    const watcher = new RepoWatcher();
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      // The root is gone by the time the watch is asked for, which is what `fs.watch`
      // throwing looks like from the watcher's side.
      rmSync(root, { recursive: true, force: true });
      watcher.start(root);
      expect(watcher.backend()).toBe("none");
      expect(watcher.isTruncated()).toBe(true);
      watcher.setDirty(false);
      expect(watcher.isDirty()).toBe(true);
      expect(warned.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
        "no recursive watch available",
      );
    } finally {
      warned.mockRestore();
      await watcher.close();
    }
  });

  it("returns no git answer for a directory that is not a repository, and still ignores the floor", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "rennet-repo-watcher-nogit-"));
    try {
      // `git ls-files` outside a repository exits non-zero. The watcher must fall back to
      // the `.git`/`.nx`/`node_modules` floor rather than treat "no answer" as "nothing
      // is ignored".
      expect(readGitIgnoredEntries(root)).toBeUndefined();
      expect(isIgnoredPath(root, join(root, "node_modules", "x", "index.js"))).toBe(true);
      expect(isIgnoredPath(root, join(root, "src", "app.ts"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// What none of the above catches, written down rather than left to be discovered.
//
// - **Windows.** The recursive backend's Windows path (`ReadDirectoryChangesW`) is never
//   executed by any gate: `pnpm check` runs on macOS locally and ubuntu in CI, and the only
//   Windows job in CI is the native-module matrix. The descriptor claim is a property of
//   every recursive backend, but that is reasoning, not a run.
// - **Symlinks.** The recursive backend does not follow a symlink out of the tree and the
//   per-entry one did. That is a real, narrow regression and there is no test for it here;
//   it is stated at `RepoWatcher.start` instead.
// - **The daemon's real descriptor ceiling.** These tests prove the cost is a constant, not
//   that any particular machine's limit is survivable — which is precisely the number that
//   turned out to be unknowable, and the reason the constant is what matters.
// - **The 41,887 storm itself.** `RepoWatcher error channel` drives 5,000 synthetic error
//   events through the real emitter. It proves the collapsing and the survival; it does not
//   reproduce EMFILE, because reproducing EMFILE means exhausting the test runner's own
//   descriptors, which is what took a vitest run down with exit 144 in #855.

// The log storm is its own defect. The 0.9.1 daemon log was 42,697 lines of which 41,887
// were one identical EMFILE sentence — 98% of the file — and two real daemon crashes plus a
// dead T3 sidecar were buried in the remainder. Rai reads that file to diagnose.
describe("RepeatCollapsingLog", () => {
  it("collapses a storm to one line per decade and never loses the count", async () => {
    const { RepeatCollapsingLog } = await import("./repo-watcher");
    const lines: string[] = [];
    const log = new RepeatCollapsingLog((line) => lines.push(line));
    for (let i = 0; i < 41_887; i += 1) log.record("EMFILE: too many open files, watch");
    // Five lines while the storm runs: the first, then each decade.
    expect(lines).toEqual([
      "EMFILE: too many open files, watch",
      "EMFILE: too many open files, watch (repeated 10 times)",
      "EMFILE: too many open files, watch (repeated 100 times)",
      "EMFILE: too many open files, watch (repeated 1000 times)",
      "EMFILE: too many open files, watch (repeated 10000 times)",
    ]);
    // …and the exact total on flush, so the reader learns how many there were rather than
    // that there were "lots". This is the assertion that stops collapsing from hiding.
    log.flush();
    expect(lines.at(-1)).toBe("EMFILE: too many open files, watch (repeated 41887 times)");
    expect(lines).toHaveLength(6);
    // Flushing again adds nothing: the total is already on the record.
    log.flush();
    expect(lines).toHaveLength(6);
  });

  it("closes off the running count when a DIFFERENT message arrives, so nothing is merged", async () => {
    const { RepeatCollapsingLog } = await import("./repo-watcher");
    const lines: string[] = [];
    const log = new RepeatCollapsingLog((line) => lines.push(line));
    for (let i = 0; i < 3; i += 1) log.record("EISDIR: illegal operation");
    log.record("ENOENT: no such file");
    expect(lines).toEqual([
      "EISDIR: illegal operation",
      "EISDIR: illegal operation (repeated 3 times)",
      "ENOENT: no such file",
    ]);
    // A second error is not swallowed by the first one's tally, and its own count starts
    // from scratch rather than continuing the previous message's.
    for (let i = 0; i < 9; i += 1) log.record("ENOENT: no such file");
    expect(lines.at(-1)).toBe("ENOENT: no such file (repeated 10 times)");
  });
});

// The watcher's own error channel is the collapsing one — an unhandled "error" event on an
// EventEmitter is a process crash, and 41,887 handled-but-unread ones is a useless log.
describe("RepoWatcher error channel", () => {
  it("survives an error storm without crashing and without 41,887 log lines", async () => {
    const { RepoWatcher } = await import("./repo-watcher");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "rennet-repo-watcher-storm-"));
    const watcher = new RepoWatcher();
    const said = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      watcher.start(root);
      const inner = (watcher as unknown as { watcher: { emit(e: string, x: unknown): void } })
        .watcher;
      const storm = Object.assign(new Error("EMFILE: too many open files, watch"), {
        code: "EMFILE",
      });
      // Unhandled, any one of these emits would kill the process.
      for (let i = 0; i < 5_000; i += 1) {
        expect(() => inner.emit("error", storm)).not.toThrow();
      }
      // 5,000 errors, four lines — and `close` adds the exact total as a fifth.
      expect(said).toHaveBeenCalledTimes(4);
      await watcher.close();
      expect(said).toHaveBeenCalledTimes(5);
      expect(String(said.mock.calls.at(-1)?.[1])).toContain("(repeated 5000 times)");
    } finally {
      said.mockRestore();
      await watcher.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
