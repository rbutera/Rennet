// The recursive backend's failure-to-arm branch, driven on every platform.
//
// It needs its own file because `vi.mock` is file-scoped, and it needs mocking at all for a
// reason worth stating: the branch is reachable for real only where `fs.watch` throws
// SYNCHRONOUSLY, which is macOS and Windows. On Linux Node's recursive watcher is userland
// and defers its walk, so a missing root produces a watcher object and no throw — CI found
// exactly that, as `expected 'recursive' to be 'none'`.
//
// That asymmetry is why Linux does not use this backend at all (see `hasKernelRecursiveWatch`).
// A backend that sets `settled` immediately has no safety net if arming quietly failed: it
// would vouch for a tree it is not watching, which is a freshness lie and worse than the
// descriptor bug. The per-entry backend Linux keeps has that net, because `settled` waits on
// chokidar's `ready`.
//
// So what is faked here is the PLATFORM, not the code under test. The catch branch, the
// truncation flag, the warning and `setDirty` are all the real ones.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    watch: (...args: unknown[]) => {
      // Only the recursive form is refused; chokidar's per-entry calls are left alone.
      const options = args[1] as { recursive?: boolean } | undefined;
      if (options?.recursive === true) {
        throw Object.assign(new Error("EMFILE: too many open files, watch"), { code: "EMFILE" });
      }
      return (actual.watch as (...a: never[]) => unknown)(...(args as never[]));
    },
  };
});

const realPlatform = process.platform;
afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
});

describe("RepoWatcher — a root it could not arm a watch on (#892)", () => {
  it("refuses to vouch instead of reporting a watcher it does not have", async () => {
    // Claim the platform that selects the recursive backend, so this runs everywhere the
    // suite does rather than only where the gate happens to be.
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const { RepoWatcher } = await import("./repo-watcher");
    const root = mkdtempSync(join(tmpdir(), "rennet-repo-watcher-unarmable-"));
    const watcher = new RepoWatcher();
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      watcher.start(root);

      // No watcher, and it says so rather than reporting one.
      expect(watcher.backend()).toBe("none");
      // The load-bearing half: a root that is not watched can never answer "unchanged", so
      // every freshness ask falls through to a real diff. Without this the daemon would be
      // silent about a moving tree — the failure this whole change exists to avoid, arriving
      // by a different door.
      expect(watcher.isTruncated()).toBe(true);
      watcher.setDirty(false);
      expect(watcher.isDirty()).toBe(true);
      // …and the reader is told, with the errno that caused it.
      const said = warned.mock.calls.map((call) => String(call[0])).join("\n");
      expect(said).toContain("no recursive watch available");
      expect(said).toContain("EMFILE");
      expect(said).toContain(root);
    } finally {
      warned.mockRestore();
      await watcher.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
