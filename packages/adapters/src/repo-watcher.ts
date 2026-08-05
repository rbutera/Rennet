import { type FSWatcher, watch } from "chokidar";

export class RepoWatcher {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;

  start(repositoryRoot: string, onPotentialChange: () => void): void {
    void this.close();
    this.watcher = watch(repositoryRoot, {
      ignoreInitial: true,
      ignored: (path) => path.includes("/.git/") || path.includes("/.rennet/"),
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
