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
      watcher.start(root, () => undefined);
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
      watcher.start(first, () => undefined);
      const original = inner();
      expect(original).not.toBeNull();

      watcher.start(first, () => undefined);
      expect(inner()).toBe(original); // same root ⇒ the SAME chokidar instance, never re-walked

      watcher.start(second, () => undefined);
      expect(inner()).not.toBe(original); // a different root is a real re-watch
    } finally {
      await watcher.close();
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
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
