import { describe, expect, it, vi } from "vitest";
import { filesystemIgnoresCase, isIgnoredPath, readGitIgnoredEntries } from "./repo-watcher";

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

  // #601 — the first save after a fresh capture. chokidar arms its watches file by file
  // as it walks the tree, and `ignoreInitial: true` suppresses everything it meets on the
  // way, so a save landing before the walk reaches that file is not reported late, it is
  // never reported at all. The reviewer edits their working tree, comes back to Rennet,
  // and is told nothing has changed while reading a diff that no longer matches.
  //
  // This drives the real filesystem and the real chokidar, because the defect is in what
  // chokidar does and cannot be seen through a fake. The tree is 400 files over eight
  // directories — smaller than any repository a reviewer would actually open — and at
  // that size the raw watcher reported this write in 0 of 20 measured runs, while its own
  // initial walk finished in about 14ms. On a real repository the walk takes seconds,
  // which is how the daemon came to answer "current" nine seconds after an edit.
  it("reports a save that lands while the tree is still being walked, then settles honestly", async () => {
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
      // Far longer than the walk needs. The event is not slow; it does not exist.
      await sleep(1_500);
      // So the freshness ask must NOT short-circuit here — it has to run a real diff,
      // which is what makes the review go stale and tells the reviewer what happened.
      expect(watcher.isDirty()).toBe(true);

      // And the flag is not merely pinned on. A watcher that cried stale forever would
      // satisfy the assertion above while being useless, so: once the walk has finished
      // and the ask has cleared, an untouched tree answers "unchanged".
      watcher.setDirty(false);
      await sleep(300);
      expect(watcher.isDirty()).toBe(false);

      // A later save — the ordinary, always-worked path — is still reported.
      writeFileSync(edited, "export const value = 1000;\n");
      await sleep(500);
      expect(watcher.isDirty()).toBe(true);
    } finally {
      await watcher.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  // #729 through the real chokidar: Rennet writing its own board must not mark the
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
      await sleep(700);
      expect(watcher.isDirty()).toBe(true);

      watcher.setDirty(false);
      writeFileSync(join(root, ".rennet", "conventions.json"), '{"rules":["one"]}\n');
      await sleep(700);
      expect(watcher.isDirty()).toBe(true);
    } finally {
      await watcher.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

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
      await sleep(700);
      expect(watcher.isDirty()).toBe(true);
    } finally {
      await watcher.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("classifies WSL UNC roots so they poll regardless of locus", async () => {
    const { isWslUncPath } = await import("./repo-watcher");
    expect(isWslUncPath("\\\\wsl.localhost\\Ubuntu\\home\\rai\\dev\\x")).toBe(true);
    expect(isWslUncPath("\\\\wsl$\\Ubuntu\\home\\rai\\dev\\x")).toBe(true);
    expect(isWslUncPath("C:\\dev\\repo")).toBe(false);
    expect(isWslUncPath("/home/rai/dev/repo")).toBe(false);
  });
});

// #850 — the descriptor budget. chokidar's Node backend arms one `fs.watch` per FILE,
// so the size of the watched set is not a performance number, it is the daemon's supply
// of file descriptors. On Rai's machine the watcher held 19,896 of them, 13,438 under
// `.claude/worktrees/` — gitignored as `.claude/*`, and invisible to a hardcoded
// `.git`/`.nx`/`node_modules` list — and after that every `spawn` failed `EBADF`: the
// T3 sidecar died, all five lens lanes with it.
//
// So these tests measure the RESOURCE, twice over: chokidar's own watch bookkeeping, and
// the process's live `FSEventWrap` handles, which is one per `fs.watch` on every platform
// (`process.getActiveResourcesInfo()`; verified against a bare 5-file `fs.watch` loop).
// A test asserting that an ignore function was consulted would pass with the budget gone.
describe("RepoWatcher descriptor budget (#850)", () => {
  /** Live `fs.watch` handles in this process — one descriptor each. */
  function fsWatchHandles(): number {
    return process.getActiveResourcesInfo().filter((resource) => /fsevent/i.test(resource)).length;
  }

  /**
   * The same count, taken once the previous test's handles have actually gone. This is
   * a PROCESS-wide measurement, so a baseline read while a sibling watcher is still
   * closing makes the delta negative — which is how the positive control for the first
   * test made the second one fail too, on nothing.
   */
  async function settledFsWatchHandles(): Promise<number> {
    let previous = -1;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const current = fsWatchHandles();
      if (current === previous) return current;
      previous = current;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return fsWatchHandles();
  }

  it("watches what git tracks and not the gitignored tree beside it, measured in descriptors", async () => {
    const { RepoWatcher } = await import("./repo-watcher");
    const { execFileSync } = await import("node:child_process");
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
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
    for (let i = 0; i < 600; i += 1)
      writeFileSync(join(root, ".claude", "worktrees", "lane-a", `f${i}.ts`), "export {};\n");

    // Four rules a hand-rolled matcher gets wrong and git does not, so what is under test
    // is the decision to ask git rather than the wording of one pattern: a NESTED
    // `.gitignore`, a NEGATION re-including a directory its parent rule excluded,
    // `.git/info/exclude` — not a `.gitignore` file at all — and a single ignored FILE.
    mkdirSync(join(root, "packages", "app", "src"), { recursive: true });
    mkdirSync(join(root, "packages", "app", "build"), { recursive: true });
    writeFileSync(join(root, "packages", "app", ".gitignore"), "build/\n");
    writeFileSync(join(root, "packages", "app", "src", "a.ts"), "export {};\n");
    for (let i = 0; i < 80; i += 1)
      writeFileSync(join(root, "packages", "app", "build", `b${i}.js`), "0;\n");
    mkdirSync(join(root, "vendor", "drop"), { recursive: true });
    mkdirSync(join(root, "vendor", "keep"), { recursive: true });
    for (let i = 0; i < 80; i += 1)
      writeFileSync(join(root, "vendor", "drop", `d${i}.ts`), "export {};\n");
    writeFileSync(join(root, "vendor", "keep", "k.ts"), "export {};\n");
    mkdirSync(join(root, "scratch"), { recursive: true });
    for (let i = 0; i < 80; i += 1)
      writeFileSync(join(root, "scratch", `s${i}.ts`), "export {};\n");
    writeFileSync(join(root, ".git", "info", "exclude"), "scratch/\n");
    writeFileSync(join(root, "notes.log"), "noise\n");
    // Committed, because git's collapsed answer stops at the outermost directory it has
    // no reason to enter — see the note on the last assertion. A repository under review
    // has tracked files by definition.
    git("add", "-A");
    git("commit", "-qm", "fixture");

    const watcher = new RepoWatcher();
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const handlesBefore = await settledFsWatchHandles();
    try {
      watcher.start(root);
      await new Promise((resolve) => setTimeout(resolve, 1_500));

      const watched = watcher.watchedPaths();
      const armed = fsWatchHandles() - handlesBefore;

      // Non-vacuous first: the watcher really did arm watches, and the measurement really
      // does see them on this platform. Without this the bounds below pass on a watcher
      // that watched nothing at all.
      expect(watched.length).toBeGreaterThan(12);
      expect(armed).toBeGreaterThan(12);

      // The resource claim. 856 files exist under this root and 16 of them are watchable;
      // the other 840 are ignored by four different git mechanisms. With the ignore rules
      // gone the count is ~860 either way, so this bound is what separates the two.
      expect(watched.length).toBeLessThan(40);
      expect(armed).toBeLessThan(40);

      // …and specifically these trees, named, so a bound met by dropping the wrong things
      // still fails.
      const joined = watched.join("\n");
      expect(joined).not.toMatch(/\.claude/); // root .gitignore
      expect(joined).not.toMatch(/packages\/app\/build/); // nested .gitignore
      expect(joined).not.toMatch(/vendor\/drop/); // `vendor/*`
      expect(joined).not.toMatch(/scratch/); // .git/info/exclude
      expect(joined).not.toMatch(/notes\.log/); // a single ignored file
      // The negation is git's answer too, and it is watched.
      expect(joined).toMatch(/vendor\/keep\/k\.ts/);
      expect(joined).toMatch(/packages\/app\/src\/a\.ts/);
      expect(joined).toMatch(/src\/f0\.ts/);

      // A watcher this small still has to report the reviewer's own edit, or the bound
      // above is satisfied by a watcher that gave up.
      watcher.setDirty(false);
      expect(watcher.isDirty()).toBe(false);
      writeFileSync(join(root, "src", "f0.ts"), "export const changed = 1;\n");
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(watcher.isDirty()).toBe(true);

      // What this does NOT catch, executed and stated rather than left to be discovered.
      // `git ls-files --directory` collapses at the outermost directory git has no reason
      // to enter, so an ignored subtree inside a WHOLLY UNTRACKED directory is absent from
      // git's answer even though git itself calls it ignored — the two assertions below
      // are that disagreement, run. Closing it means enumerating every ignored file, which
      // on this repository is 122,561 entries, 8.1 MB and 2.35s of blocked event loop
      // against 46 entries, 1.3 KB and 42ms. So the BUDGET covers this case, not the rules.
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
  }, 20_000);

  // The bound has to hold when the ignore rules are RIGHT and the tree is simply bigger
  // than the watcher can hold — the case no ignore rule can fix. Exercised at 64 entries
  // rather than the production 8,192 so the fixture is buildable; the mechanism is the
  // same code path, and `MAX_WATCHED_ENTRIES` is what the daemon's `new RepoWatcher()`
  // takes. What this cannot catch: whether 8,192 is the right number for a real machine's
  // descriptor limit. That is a judgement recorded where the constant is declared.
  it("stops at its budget on a tree with nothing to ignore, and says so instead of failing silently", async () => {
    const { RepoWatcher } = await import("./repo-watcher");
    const { execFileSync } = await import("node:child_process");
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "rennet-repo-watcher-budget-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, stdio: "ignore" });
    for (let d = 0; d < 6; d += 1) {
      mkdirSync(join(root, `d${d}`), { recursive: true });
      for (let i = 0; i < 50; i += 1)
        writeFileSync(join(root, `d${d}`, `f${i}.ts`), "export {};\n");
    }

    const watcher = new RepoWatcher({ maxWatchedEntries: 64 });
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const handlesBefore = await settledFsWatchHandles();
    try {
      watcher.start(root);
      await new Promise((resolve) => setTimeout(resolve, 1_500));

      const armed = fsWatchHandles() - handlesBefore;
      expect(armed).toBeGreaterThan(0);
      // 306 entries exist; the budget is 64. `getWatched` counts a few bookkeeping
      // entries the walk never armed a descriptor for, so the descriptor count is the
      // one held to the budget exactly.
      expect(armed).toBeLessThanOrEqual(64);
      expect(watcher.watchedPaths().length).toBeLessThan(80);

      // Honest degradation, which is the half that keeps the daemon usable: the watcher
      // knows it is partial, says which root and how many, and refuses to vouch — so
      // freshness runs a real diff rather than answering "current" from a watcher that
      // is not looking at most of the tree.
      expect(watcher.isTruncated()).toBe(true);
      watcher.setDirty(false);
      expect(watcher.isDirty()).toBe(true);
      const said = warned.mock.calls.map((call) => String(call[0])).join("\n");
      expect(said).toContain("watch budget spent: 64 entries");
      expect(said).toContain(root);
      // Said once for the root, not once per entry — the failure it replaces was 16,751
      // identical lines in one daemon lifetime.
      expect(said.match(/watch budget spent/g)).toHaveLength(1);
    } finally {
      warned.mockRestore();
      await watcher.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  // The budget is derived from the process's real `RLIMIT_NOFILE`, not guessed, because
  // the number that matters differs by an order of magnitude between a shell and an app
  // launched from Finder — and a constant tuned for one is wrong for the other.
  it("takes half of this process's own descriptor limit, capped at the ceiling", async () => {
    const { MAX_WATCHED_ENTRIES, watchBudget } = await import("./repo-watcher");
    const limits = (
      process.report.getReport() as {
        userLimits?: { open_files?: { soft?: number | string } };
      }
    ).userLimits;
    const soft = limits?.open_files?.soft;
    // Non-vacuous: this platform must actually report a limit, or the expectation below
    // is comparing the ceiling with itself.
    expect(typeof soft).toBe("number");
    expect(watchBudget()).toBe(Math.min(MAX_WATCHED_ENTRIES, Math.floor(Number(soft) / 2)));
    // …and this shell's limit is high, so the ceiling is what is actually in force here.
    // The halving branch is the one that matters on a Finder-launched daemon.
    expect(watchBudget()).toBeGreaterThan(0);
  });

  it("returns no git answer for a directory that is not a repository, and the caller still bounds it", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "rennet-repo-watcher-nogit-"));
    try {
      // `git ls-files` outside a repository exits non-zero. The watcher must fall back to
      // the `.git`/`.nx`/`node_modules` floor rather than treat "no answer" as "nothing
      // is ignored" — and the budget is what makes that fallback survivable.
      expect(readGitIgnoredEntries(root)).toBeUndefined();
      expect(isIgnoredPath(root, join(root, "node_modules", "x", "index.js"))).toBe(true);
      expect(isIgnoredPath(root, join(root, "src", "app.ts"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
