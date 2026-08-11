import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  ProjectSnapshotGenerator,
  ProjectSnapshotStore,
  type Timers,
  type WatchFn,
} from "@rennet/adapters";
import type { Project, ProjectProcessEvent } from "@rennet/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProactiveRehydration,
  projectRepoPaths,
  type RepoRehydrationHandle,
  startRepoRehydration,
} from "./proactive-rehydration";

// ── scratch dirs ─────────────────────────────────────────────────────────────
const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ── a manual clock so the debounce is deterministic (no real timers) ─────────
function fakeTimers(): { timers: Timers; flush: () => void; pending: () => boolean } {
  let cb: (() => void) | null = null;
  return {
    timers: {
      setTimeout: (fn) => {
        cb = fn;
        return {};
      },
      clearTimeout: () => {
        cb = null;
      },
    },
    flush: () => {
      const fn = cb;
      cb = null;
      fn?.();
    },
    pending: () => cb !== null,
  };
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function write(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

/** A minimal one-package workspace repo on `main`, plus a way to advance the tip. */
function repoOnMain(): { root: string; storeDir: string; oid1: string; advance: () => string } {
  const root = mkdtempSync(join(tmpdir(), "rennet-rehydrate-"));
  const storeDir = mkdtempSync(join(tmpdir(), "rennet-rehydrate-store-"));
  scratch.push(root, storeDir);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "rennet@example.test");
  git(root, "config", "user.name", "Rennet Test");
  write(root, "pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
  write(root, "packages/a/package.json", JSON.stringify({ name: "@t/a", main: "./src/index.ts" }));
  write(root, "packages/a/src/index.ts", "export const a = 1;\nexport function makeA() {}\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "one");
  const oid1 = git(root, "rev-parse", "HEAD");
  let advanced = false;
  return {
    root,
    storeDir,
    oid1,
    advance: () => {
      // A real advance of main: change one file, add one, commit.
      write(root, "packages/a/src/index.ts", "export const a = 2;\nexport function makeA() {}\n");
      write(
        root,
        `packages/a/src/added-${advanced ? "2" : "1"}.ts`,
        "export const added = true;\n",
      );
      advanced = true;
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "advance");
      return git(root, "rev-parse", "HEAD");
    },
  };
}

/** Capture the fs.watch listeners so a ref change can be fired deterministically. */
function capturingWatch(): { watch: WatchFn; targets: string[]; fire: (needle: string) => void } {
  const listeners: { path: string; fn: () => void }[] = [];
  return {
    watch: (path, listener) => {
      listeners.push({ path, fn: listener });
      return {
        close: () => {
          /* no teardown needed */
        },
      };
    },
    get targets() {
      return listeners.map((l) => l.path);
    },
    fire: (needle) => {
      const hit = listeners.find((l) => l.path.includes(needle));
      if (!hit)
        throw new Error(
          `no watch registered matching ${needle}: ${listeners.map((l) => l.path).join(", ")}`,
        );
      hit.fn();
    },
  };
}

describe("proactive rehydration — end to end over a real git repo", () => {
  it("a reference-branch advance runs exactly one coalesced delta pass at the new tip", async () => {
    const { root, storeDir, oid1, advance } = repoOnMain();
    const store = new ProjectSnapshotStore(storeDir);
    const generator = new ProjectSnapshotGenerator({ store });

    // The initial context dump already built the Repo Map at main (oid1).
    await generator.generate(root, { explicitBaseRef: "main" });
    const generateSpy = vi.spyOn(generator, "generate");

    const events: ProjectProcessEvent[] = [];
    const done = deferred();
    const clock = fakeTimers();
    const watcher = capturingWatch();

    const handle = await startRepoRehydration({
      repoPath: root,
      explicitBaseRef: "main",
      store,
      generator,
      narrate: (event) => {
        events.push(event);
        if (event.kind === "repo-done" || event.kind === "repo-error") done.resolve();
      },
      watch: watcher.watch,
      timers: clock.timers,
    });

    expect(handle).not.toBeNull();
    // The NEW watch target: local branch tips, so a local advance fires (not only a fetch).
    expect(watcher.targets.some((t) => t.endsWith(join("refs", "heads")))).toBe(true);

    // Manifest starts at oid1.
    expect(store.loadManifest(handle?.repoKey ?? "")?.baseOid).toBe(oid1);

    // main advances; a burst of five fs events lands (a rebase / several commits).
    const oid2 = advance();
    watcher.fire(`${sep}refs${sep}heads`);
    watcher.fire(`${sep}refs${sep}heads`);
    watcher.fire(`${sep}refs${sep}heads`);
    watcher.fire(`${sep}refs${sep}heads`);
    watcher.fire(`${sep}refs${sep}heads`);

    // The burst collapsed to a single pending debounced drain, not five.
    expect(clock.pending()).toBe(true);
    clock.flush();
    await done.promise;

    // Exactly ONE regen ran (coalesced), and it advanced the store to the NEW tip.
    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(store.loadManifest(handle?.repoKey ?? "")?.baseOid).toBe(oid2);

    // The pass was VISIBLE: it bracketed with repo-start → stages → repo-done, and the
    // done summary carries the regen's REAL counts (not a fabricated placeholder).
    expect(events[0]?.kind).toBe("repo-start");
    expect(events.some((e) => e.kind === "stage")).toBe(true);
    const last = events.at(-1);
    expect(last?.kind).toBe("repo-done");
    if (last?.kind === "repo-done") {
      expect(last.summary.ok).toBe(true);
      if (last.summary.ok) {
        expect(last.summary.files).toBeGreaterThan(0);
        expect(last.summary.baseRef).toBe("main");
      }
    }

    handle?.close();
  });

  it("a never-built repo is not cold-built in the background (returns null, no watch)", async () => {
    const { root, storeDir } = repoOnMain();
    const store = new ProjectSnapshotStore(storeDir);
    const generator = new ProjectSnapshotGenerator({ store });
    const generateSpy = vi.spyOn(generator, "generate");
    const watcher = capturingWatch();

    // No initial generate → no manifest → nothing to keep warm.
    const handle = await startRepoRehydration({
      repoPath: root,
      explicitBaseRef: "main",
      store,
      generator,
      narrate: () => {
        /* ignored */
      },
      watch: watcher.watch,
      timers: fakeTimers().timers,
    });

    expect(handle).toBeNull();
    expect(watcher.targets).toHaveLength(0);
    expect(generateSpy).not.toHaveBeenCalled();
  });
});

describe("proactive rehydration — the registry", () => {
  const project = (over: Partial<Project> = {}): Project =>
    ({
      id: "p1",
      name: "P1",
      path: "/repo/a",
      openPath: "/repo/a",
      primaryBranch: "main",
      includedRepoPaths: ["/repo/a", "/repo/b"],
      ...over,
    }) as Project;

  it("starts one watcher per included repo and is idempotent by repoKey", async () => {
    const closed: string[] = [];
    const started: string[] = [];
    const startRepo = vi.fn(
      async (deps: { repoPath: string }): Promise<RepoRehydrationHandle | null> => {
        // Both included repos share one common dir → the SAME repoKey (a worktree pair).
        const repoKey = "shared-key";
        started.push(deps.repoPath);
        return { repoKey, close: () => closed.push(deps.repoPath) };
      },
    );
    const registry = createProactiveRehydration({
      store: {} as never,
      generator: {} as never,
      narrate: () => {
        /* ignored */
      },
      startRepo,
    });

    await registry.ensureForProject(project());
    // Two repos attempted; the second's duplicate repoKey was closed, one handle kept.
    expect(started).toEqual(["/repo/a", "/repo/b"]);
    expect(closed).toEqual(["/repo/b"]);

    // A second ensure for the same project starts nothing new (repoKey already warm)…
    started.length = 0;
    await registry.ensureForProject(project());
    // …the duplicate is still closed each attempt, but no new handle is retained.
    registry.closeAll();
    // closeAll closed the one retained handle (repo /repo/a).
    expect(closed).toContain("/repo/a");
  });

  it("projectRepoPaths falls back to the single open path when no included repos", () => {
    expect(projectRepoPaths(project({ includedRepoPaths: [] }))).toEqual(["/repo/a"]);
    expect(projectRepoPaths(project({ includedRepoPaths: ["/x", "/y"] }))).toEqual(["/x", "/y"]);
  });
});
