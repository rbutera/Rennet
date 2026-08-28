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
  /** The root the live watcher is on, so a repeat `start` for it is recognised as a no-op. */
  private root: string | null = null;
  /**
   * False until chokidar has finished its initial walk of the tree. Nothing that
   * lands before that walk arms a watch is ever reported — see `setDirty`.
   */
  private settled = false;
  /**
   * Has the repository changed since the last trustworthy clear? The watcher owns
   * this rather than the daemon because the watcher is the only thing that knows
   * whether its own silence means anything (#601).
   */
  private dirty = true;

  /**
   * Watch a repo root for changes. For a WSL-locus project the root is a
   * `\\wsl.localhost\<distro>\…` UNC view, where inotify events do NOT propagate
   * across the 9P/UNC boundary (design decision 7) — so the WSL locus watches by
   * POLLING. Host projects keep native (event-driven) watching. The ignore set
   * (`.git`/`.rennet`/`node_modules`) matches both path-separator flavours
   * (backslashes on Windows/UNC); pruning `node_modules` is what keeps the poll
   * from stat-storming the 9P bridge.
   */
  start(repositoryRoot: string, locus: Locus = HOST_LOCUS): void {
    // Re-`start` on the root already being watched is a NO-OP, and that is a correctness fix,
    // not an optimisation. Tearing the watcher down and re-walking the tree opens a window in
    // which `ignoreInitial: true` means every edit that lands is never reported — a review that
    // went stale and never says so, the exact failure freshness exists to prevent. `review.load`
    // calls `startWatching` on every open, so any client that re-reads a review (the #576
    // freshness ask does, on every window focus) would otherwise rebuild the chokidar tree on
    // each alt-tab. Same root ⇒ keep the live watcher, its armed watches and its accumulated
    // dirty flag; a repeat start on a settled root must NOT re-open the warm-up window below.
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
    this.watcher.on("ready", () => {
      this.settled = true;
    });
    // Recorded synchronously, with no debounce. The flag is read by a freshness ask
    // that can arrive at any moment, and a 250ms coalescing window was simply 250ms
    // in which an edit that HAD been seen still answered "current".
    this.watcher.on("all", () => {
      this.dirty = true;
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

  /** Has the repository changed since the last trustworthy clear? */
  isDirty(): boolean {
    return this.dirty;
  }

  /**
   * Record, or clear, "the tree has moved since the review was pinned".
   *
   * Clearing only STICKS once the initial walk has finished (#601). chokidar arms
   * its watches file by file as it walks, and `ignoreInitial: true` suppresses
   * everything it finds on the way — so a save that lands before the walk reaches
   * that file is not late, it is *lost*, permanently. Measured on this repo: a
   * write issued in the same tick as `start()` on a 400-file tree was never
   * reported in 20 of 20 runs, while the walk itself finished in ~14ms. A real
   * repository is far larger, which is why the daemon was seen answering "current"
   * nine seconds after an edit.
   *
   * So while the walk is in flight the watcher refuses to vouch for the tree, and
   * the caller falls through to a real diff instead of trusting a silence that
   * means nothing yet. This costs a handful of extra diffs in the first moments of
   * a capture and closes the window completely: the flag can only go clean at a
   * moment after which every subsequent change is guaranteed to be reported.
   */
  setDirty(value: boolean): void {
    this.dirty = value || !this.settled;
  }

  async close(): Promise<void> {
    // Release the fields BEFORE awaiting. `start` calls `close` without awaiting and
    // then synchronously installs the new watcher; nulling after the await would land
    // in a later microtask and wipe that new watcher out, orphaning a live chokidar
    // instance and defeating the same-root no-op above — which re-walks the tree on
    // the next `review.load` and re-opens the very window `setDirty` exists to close.
    const watcher = this.watcher;
    this.watcher = null;
    this.root = null;
    this.settled = false;
    this.dirty = true;
    await watcher?.close();
  }
}
