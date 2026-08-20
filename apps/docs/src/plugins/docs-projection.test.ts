import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalPathForProjected,
  type DocsProjectionEvent,
  type DocsProjectionWatcher,
  syncDocsProjection,
  watchDocsProjection,
} from "./docs-projection";

const temporaryDirectories: string[] = [];

class TestWatcher implements DocsProjectionWatcher {
  readonly listeners = new Map<
    DocsProjectionEvent["kind"],
    (canonicalPath: string) => Promise<void>
  >();
  watchedPath: string | undefined;

  add(path: string): void {
    this.watchedPath = path;
  }

  on(event: DocsProjectionEvent["kind"], listener: (canonicalPath: string) => Promise<void>): void {
    this.listeners.set(event, listener);
  }

  async emit(event: DocsProjectionEvent["kind"], canonicalPath: string): Promise<void> {
    const listener = this.listeners.get(event);
    if (!listener) throw new Error(`No ${event} listener registered`);
    await listener(canonicalPath);
  }
}

async function temporaryProjection() {
  const root = await mkdtemp(join(tmpdir(), "rennet-docs-projection-"));
  temporaryDirectories.push(root);
  const canonicalRoot = join(root, "docs");
  const projectionRoot = join(root, "apps", "docs", "src", "content", "docs");
  await mkdir(canonicalRoot, { recursive: true });
  await mkdir(projectionRoot, { recursive: true });
  return { canonicalRoot, projectionRoot };
}

function startWatcher(paths: { canonicalRoot: string; projectionRoot: string }): TestWatcher {
  const watcher = new TestWatcher();
  watchDocsProjection({
    ...paths,
    watcher,
    onProjected: () => undefined,
    onError: (error) => {
      throw error;
    },
  });
  expect(watcher.watchedPath).toBe(paths.canonicalRoot);
  return watcher;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("canonical docs projection", () => {
  it("copies the canonical documentation sections on initial sync", async () => {
    const paths = await temporaryProjection();
    await mkdir(join(paths.canonicalRoot, "using", "guides"), { recursive: true });
    await writeFile(join(paths.canonicalRoot, "using", "guides", "start.md"), "canonical\n");

    await syncDocsProjection(paths);

    await expect(
      readFile(join(paths.projectionRoot, "using", "guides", "start.md"), "utf8"),
    ).resolves.toBe("canonical\n");
  });

  it("deletes stale projected files without deleting the app-owned homepage", async () => {
    const paths = await temporaryProjection();
    await mkdir(join(paths.projectionRoot, "developing"), { recursive: true });
    await writeFile(join(paths.projectionRoot, "developing", "stale.md"), "stale\n");
    await writeFile(join(paths.projectionRoot, "index.mdx"), "homepage\n");

    await syncDocsProjection(paths);

    await expect(
      readFile(join(paths.projectionRoot, "developing", "stale.md"), "utf8"),
    ).rejects.toThrow();
    await expect(readFile(join(paths.projectionRoot, "index.mdx"), "utf8")).resolves.toBe(
      "homepage\n",
    );
  });

  it("projects a canonical file added while development is running", async () => {
    const paths = await temporaryProjection();
    const canonicalPath = join(paths.canonicalRoot, "using", "new.md");
    await mkdir(join(paths.canonicalRoot, "using"), { recursive: true });
    await writeFile(canonicalPath, "added\n");

    await startWatcher(paths).emit("add", canonicalPath);

    await expect(readFile(join(paths.projectionRoot, "using", "new.md"), "utf8")).resolves.toBe(
      "added\n",
    );
  });

  it("updates a projected file when its canonical source changes", async () => {
    const paths = await temporaryProjection();
    const canonicalPath = join(paths.canonicalRoot, "developing", "current.md");
    await mkdir(join(paths.canonicalRoot, "developing"), { recursive: true });
    await writeFile(canonicalPath, "before\n");
    const watcher = startWatcher(paths);
    await watcher.emit("add", canonicalPath);
    await writeFile(canonicalPath, "after\n");

    await watcher.emit("change", canonicalPath);

    await expect(
      readFile(join(paths.projectionRoot, "developing", "current.md"), "utf8"),
    ).resolves.toBe("after\n");
  });

  it("deletes a projected file when its canonical source is unlinked", async () => {
    const paths = await temporaryProjection();
    const canonicalPath = join(paths.canonicalRoot, "adr", "0001-test.md");
    await mkdir(join(paths.canonicalRoot, "adr"), { recursive: true });
    await writeFile(canonicalPath, "decision\n");
    const watcher = startWatcher(paths);
    await watcher.emit("add", canonicalPath);
    await rm(canonicalPath);

    await watcher.emit("unlink", canonicalPath);

    await expect(
      readFile(join(paths.projectionRoot, "adr", "0001-test.md"), "utf8"),
    ).rejects.toThrow();
  });

  it("maps a projected Starlight entry back to its canonical repository path", () => {
    expect(canonicalPathForProjected("src/content/docs/using/guides/start.md")).toBe(
      "docs/using/guides/start.md",
    );
    expect(canonicalPathForProjected("src/content/docs/index.mdx")).toBeUndefined();
  });
});
