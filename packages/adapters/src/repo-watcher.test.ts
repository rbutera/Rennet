import { describe, expect, it, vi } from "vitest";
import { isIgnoredPath } from "./repo-watcher";

describe("isIgnoredPath (add-windows-support: both separator flavours)", () => {
  it("ignores .git and .rennet on POSIX paths", () => {
    expect(isIgnoredPath("/repo/.git/HEAD")).toBe(true);
    expect(isIgnoredPath("/repo/.rennet/map/x")).toBe(true);
  });

  it("ignores .git and .rennet on Windows/UNC paths (backslashes)", () => {
    expect(isIgnoredPath("\\\\wsl.localhost\\Ubuntu\\home\\rai\\repo\\.git\\HEAD")).toBe(true);
    expect(isIgnoredPath("C:\\dev\\repo\\.rennet\\map\\x")).toBe(true);
  });

  // `.nx` is gitignored, so it can never enter a capture, and on this repository it is
  // 4,877 of 23,549 entries — a fifth of the walk, for nothing. Pruning it took the initial
  // walk from ~64s to ~900ms and 4,176–4,779 EMFILE failures to zero.
  it("ignores .nx — a fifth of this repo's tree, and git can never show it", () => {
    expect(isIgnoredPath("/repo/.nx/workspace-data/d.db")).toBe(true);
    expect(isIgnoredPath("/repo/.nx")).toBe(true);
    expect(isIgnoredPath("C:\\dev\\repo\\.nx\\workspace-data\\d.db")).toBe(true);
    // Not a prefix match: a real source directory whose name merely starts with it stays.
    expect(isIgnoredPath("/repo/src/.nxrc/config.ts")).toBe(false);
  });

  it("ignores node_modules — the 9P poll storm's source (contents and the dir itself)", () => {
    expect(isIgnoredPath("/repo/node_modules/foo/index.js")).toBe(true);
    expect(
      isIgnoredPath("\\\\wsl.localhost\\Ubuntu\\home\\rai\\repo\\node_modules\\.bin\\semver"),
    ).toBe(true);
    // The directory entry itself must match so chokidar prunes before descending.
    expect(isIgnoredPath("/repo/node_modules")).toBe(true);
    expect(isIgnoredPath("C:\\dev\\repo\\node_modules")).toBe(true);
  });

  it("does not ignore ordinary source files", () => {
    expect(isIgnoredPath("/repo/src/app.ts")).toBe(false);
    expect(isIgnoredPath("C:\\dev\\repo\\src\\app.ts")).toBe(false);
    // A file whose name merely starts with an ignored segment is not ignored.
    expect(isIgnoredPath("/repo/src/node_modules_helper.ts")).toBe(false);
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

  it("classifies WSL UNC roots so they poll regardless of locus", async () => {
    const { isWslUncPath } = await import("./repo-watcher");
    expect(isWslUncPath("\\\\wsl.localhost\\Ubuntu\\home\\rai\\dev\\x")).toBe(true);
    expect(isWslUncPath("\\\\wsl$\\Ubuntu\\home\\rai\\dev\\x")).toBe(true);
    expect(isWslUncPath("C:\\dev\\repo")).toBe(false);
    expect(isWslUncPath("/home/rai/dev/repo")).toBe(false);
  });
});
