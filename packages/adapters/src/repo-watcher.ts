import { HOST_LOCUS, type Locus } from "@rennet/core";
import { type FSWatcher, watch } from "chokidar";

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
    this.watcher = watch(repositoryRoot, {
      ignoreInitial: true,
      ignored: (path) => isIgnoredPath(path),
      ...(locus.kind === "wsl" ? { usePolling: true, interval: 500 } : {}),
    });
    this.watcher.on("all", () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(onPotentialChange, 250);
    });
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.watcher?.close();
    this.watcher = null;
  }
}
