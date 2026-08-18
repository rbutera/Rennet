import { HOST_LOCUS, type Locus } from "@rennet/core";
import { type FSWatcher, watch } from "chokidar";

/** True for a `\\wsl.localhost\…` / `\\wsl$\…` UNC view of a WSL filesystem. */
export function isWslUncPath(path: string): boolean {
  return /^\\\\wsl(\$|\.localhost)\\/i.test(path);
}

/** True when a watched path is inside `.git`/`.rennet` (either separator flavour). */
export function isIgnoredPath(path: string): boolean {
  return /[/\\]\.git[/\\]/.test(path) || /[/\\]\.rennet[/\\]/.test(path);
}

export class RepoWatcher {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;

  /**
   * Watch a repo root for changes. For a WSL-locus project the root is a
   * `\\wsl.localhost\<distro>\…` UNC view, where inotify events do NOT propagate
   * across the 9P/UNC boundary (design decision 7) — so the WSL locus watches by
   * POLLING. Host projects keep native (event-driven) watching. The `.git`/`.rennet`
   * ignore matches both path-separator flavours (backslashes on Windows/UNC).
   */
  start(repositoryRoot: string, onPotentialChange: () => void, locus: Locus = HOST_LOCUS): void {
    void this.close();
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
  }
}
