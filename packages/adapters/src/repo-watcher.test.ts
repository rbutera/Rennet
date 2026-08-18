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

  it("does not ignore ordinary source files", () => {
    expect(isIgnoredPath("/repo/src/app.ts")).toBe(false);
    expect(isIgnoredPath("C:\\dev\\repo\\src\\app.ts")).toBe(false);
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

  it("classifies WSL UNC roots so they poll regardless of locus", async () => {
    const { isWslUncPath } = await import("./repo-watcher");
    expect(isWslUncPath("\\\\wsl.localhost\\Ubuntu\\home\\rai\\dev\\x")).toBe(true);
    expect(isWslUncPath("\\\\wsl$\\Ubuntu\\home\\rai\\dev\\x")).toBe(true);
    expect(isWslUncPath("C:\\dev\\repo")).toBe(false);
    expect(isWslUncPath("/home/rai/dev/repo")).toBe(false);
  });
});
