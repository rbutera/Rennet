import { HOST_LOCUS, type Locus } from "@rennet/core";
import { type FSWatcher, watch } from "chokidar";

/** True for a `\\wsl.localhost\…` / `\\wsl$\…` UNC view of a WSL filesystem. */
export function isWslUncPath(path: string): boolean {
  return /^\\\\wsl(\$|\.localhost)\\/i.test(path);
}

/**
 * Segments never worth watching for review freshness: VCS/internal state
 * (`.git`, `.rennet`) and — critically — the dependency tree (`node_modules`).
 * On a WSL-UNC (9P) root the watcher POLLS, so descending `node_modules` meant
 * stat-ing tens of thousands of files every interval, and the pnpm `.bin`
 * symlinks even throw spurious EISDIR over the 9P bridge — a flood that both
 * spammed the log and starved the daemon's libuv thread pool (the same pool
 * undici uses for GitHub connects; field bug, lancelot 2026-08-20). None of
 * these trees ever change a review. Matches the segment itself or its contents,
 * in either separator flavour (backslashes on Windows/UNC).
 */
const IGNORED_SEGMENT = /[/\\](?:\.git|\.rennet|node_modules)(?:[/\\]|$)/;

/** True when a watched path is inside an ignored segment. */
export function isIgnoredPath(path: string): boolean {
  return IGNORED_SEGMENT.test(path);
}

export class RepoWatcher {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** The root the live watcher is on, so a repeat `start` for it is recognised as a no-op. */
  private root: string | null = null;

  /**
   * Watch a repo root for changes. For a WSL-locus project the root is a
   * `\\wsl.localhost\<distro>\…` UNC view, where inotify events do NOT propagate
   * across the 9P/UNC boundary (design decision 7) — so the WSL locus watches by
   * POLLING. Host projects keep native (event-driven) watching. The ignore set
   * (`.git`/`.rennet`/`node_modules`) matches both path-separator flavours
   * (backslashes on Windows/UNC); pruning `node_modules` is what keeps the poll
   * from stat-storming the 9P bridge.
   */
  start(repositoryRoot: string, onPotentialChange: () => void, locus: Locus = HOST_LOCUS): void {
    // Re-`start` on the root already being watched is a NO-OP, and that is a correctness fix,
    // not an optimisation. Tearing the watcher down and re-walking the tree opens a window in
    // which `ignoreInitial: true` means every edit that lands is never reported — a review that
    // went stale and never says so, the exact failure freshness exists to prevent. `review.load`
    // calls `startWatching` on every open, so any client that re-reads a review (the #576
    // freshness ask does, on every window focus) would otherwise rebuild the chokidar tree on
    // each alt-tab. Same root ⇒ keep the live watcher and its already-registered callback; the
    // callers all pass the same "mark the repository dirty" effect, so there is nothing to swap.
    if (this.watcher && this.root === repositoryRoot) return;
    void this.close();
    this.root = repositoryRoot;
    // Polling for the WSL locus AND for any `\\wsl.localhost\…` / `\\wsl$\…` UNC root
    // regardless of the recorded locus: the 9P bridge both drops inotify events and
    // returns spurious lstat errors (EISDIR on plain files, observed live on the
    // lancelot test bed 2026-08-19), so native watching over it is wrong twice.
    const wslUncRoot = isWslUncPath(repositoryRoot);
    this.watcher = watch(repositoryRoot, {
      ignoreInitial: true,
      ignored: (path) => isIgnoredPath(path),
      ...(locus.kind === "wsl" || wslUncRoot ? { usePolling: true, interval: 500 } : {}),
    });
    this.watcher.on("all", () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(onPotentialChange, 250);
    });
    // A watcher error MUST NOT kill the daemon: chokidar's FSWatcher is an
    // EventEmitter, and an unhandled "error" event is a process crash — which is
    // exactly what took the daemon down in a loop when lstat over the WSL UNC
    // bridge failed. Freshness degrades to missed events; the daemon lives.
    this.watcher.on("error", (error) => {
      console.error(
        "[repo-watcher] watcher error (freshness may miss changes):",
        error instanceof Error ? error.message : error,
      );
    });
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.watcher?.close();
    this.watcher = null;
    this.root = null;
  }
}
