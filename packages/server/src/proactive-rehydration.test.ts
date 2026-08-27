import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  ProjectContextReader,
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
  type StartRepoRehydrationDeps,
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
  let advanceCount = 0;
  return {
    root,
    storeDir,
    oid1,
    advance: () => {
      // A real advance of main: change one file, add one, commit.
      write(root, "packages/a/src/index.ts", "export const a = 2;\nexport function makeA() {}\n");
      advanceCount += 1;
      write(root, `packages/a/src/added-${advanceCount}.ts`, "export const added = true;\n");
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
  it("a reference-branch advance runs exactly one coalesced snapshot regeneration at the new tip", async () => {
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

  it("runs knowledge upkeep from the same coalesced advance without delaying structural completion", async () => {
    const { root, storeDir, oid1, advance } = repoOnMain();
    const store = new ProjectSnapshotStore(storeDir);
    const generator = new ProjectSnapshotGenerator({ store });
    await generator.generate(root, { explicitBaseRef: "main" });
    const structuralDone = deferred();
    const knowledgeDone = deferred();
    const clock = fakeTimers();
    const watcher = capturingWatch();
    const calls: unknown[] = [];
    const handle = await startRepoRehydration({
      repoPath: root,
      explicitBaseRef: "main",
      store,
      generator,
      narrate: (event) => {
        if (event.kind === "repo-done") structuralDone.resolve();
      },
      runKnowledgePass: async (input) => {
        calls.push(input);
        if (calls.length === 2) knowledgeDone.resolve();
      },
      watch: watcher.watch,
      timers: clock.timers,
    });

    const oid2 = advance();
    watcher.fire(`${sep}refs${sep}heads`);
    clock.flush();
    await structuralDone.promise;
    await knowledgeDone.promise;

    // The INITIAL run fires at watcher start (review P1 — a freshly-processed
    // project must not wait for a baseline advance), then the advance re-targets.
    expect(calls).toEqual([
      expect.objectContaining({ repoKey: handle?.repoKey, toOid: oid1 }),
      expect.objectContaining({ repoKey: handle?.repoKey, toOid: oid2 }),
    ]);
    handle?.close();
  });

  it("coalesces to the newest target when a running knowledge pass fails", async () => {
    const { root, storeDir, oid1, advance } = repoOnMain();
    const store = new ProjectSnapshotStore(storeDir);
    const generator = new ProjectSnapshotGenerator({ store });
    await generator.generate(root, { explicitBaseRef: "main" });
    const structuralDone = [deferred(), deferred(), deferred()];
    const releaseFirst = deferred();
    const secondStarted = deferred();
    const clock = fakeTimers();
    const watcher = capturingWatch();
    const calls: { toOid: string }[] = [];
    let structuralCount = 0;
    const handle = await startRepoRehydration({
      repoPath: root,
      explicitBaseRef: "main",
      store,
      generator,
      narrate: (event) => {
        if (event.kind === "repo-done") structuralDone[structuralCount++]?.resolve();
      },
      runKnowledgePass: async (input) => {
        calls.push(input);
        if (calls.length === 1) {
          await releaseFirst.promise;
          return false;
        }
        secondStarted.resolve();
        return true;
      },
      watch: watcher.watch,
      timers: clock.timers,
    });

    advance();
    watcher.fire(`${sep}refs${sep}heads`);
    clock.flush();
    await structuralDone[0]?.promise;

    advance();
    watcher.fire(`${sep}refs${sep}heads`);
    clock.flush();
    await structuralDone[1]?.promise;
    expect(calls).toHaveLength(1);

    const oid4 = advance();
    watcher.fire(`${sep}refs${sep}heads`);
    clock.flush();
    await structuralDone[2]?.promise;
    expect(calls).toHaveLength(1);

    releaseFirst.resolve();
    await secondStarted.promise;
    expect(calls).toHaveLength(2);
    // The initial run targeted the starting baseline; the retry after its
    // failure lands on the NEWEST coalesced target (the swarm derives its own
    // delta base from the stored prior set, no from-OID bookkeeping).
    expect(calls[0]?.toOid).toBe(oid1);
    expect(calls[1]?.toOid).toBe(oid4);
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

  it("serves BOTH the new tip and an older-pinned reader warm after a background advance (#246)", async () => {
    const { root, storeDir, oid1, advance } = repoOnMain();
    const store = new ProjectSnapshotStore(storeDir);
    const generator = new ProjectSnapshotGenerator({ store });
    await generator.generate(root, { explicitBaseRef: "main" }); // manifest at oid1

    const reader = new ProjectContextReader(store);
    const done = deferred();
    const clock = fakeTimers();
    const watcher = capturingWatch();
    const handle = await startRepoRehydration({
      repoPath: root,
      explicitBaseRef: "main",
      store,
      generator,
      narrate: (event) => {
        if (event.kind === "repo-done" || event.kind === "repo-error") done.resolve();
      },
      watch: watcher.watch,
      timers: clock.timers,
    });
    const repoKey = handle?.repoKey ?? "";

    // Before the advance: a read pinned to oid1 is fresh.
    expect(reader.loadFresh(repoKey, oid1).ok).toBe(true);

    const oid2 = advance();
    watcher.fire(`${sep}refs${sep}heads`);
    clock.flush();
    await done.promise;

    // #246 (was the #143 known limitation): a background advance no longer evicts an
    // older-pinned reader. The manifest is now OID-addressable, so the advance ADDS a
    // manifest at oid2 rather than replacing the one at oid1. BOTH reads are warm: the
    // new tip AND the in-flight review still pinned to oid1. This assertion is the
    // inversion the issue required — it used to assert oid1 was refused `stale`.
    expect(reader.loadFresh(repoKey, oid2).ok).toBe(true);
    expect(reader.loadFresh(repoKey, oid1).ok).toBe(true);

    // The CURRENT pointer still advances to the newest tip (unchanged): "what is newest"
    // is oid2, while the per-OID pin keeps oid1 readable alongside it.
    expect(store.loadManifest(repoKey)?.baseOid).toBe(oid2);

    handle?.close();
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

  it("starts one watcher per included repo, dedupes by repoKey, and a second ensure starts NOTHING new", async () => {
    const closed: string[] = [];
    const startRepo = vi.fn(
      async (deps: StartRepoRehydrationDeps): Promise<RepoRehydrationHandle | null> => {
        // Both included repos share one common dir → the SAME repoKey (a worktree pair).
        return { repoKey: "shared-key", close: () => closed.push(deps.repoPath) };
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
    // One attempt per included repo; the second's duplicate repoKey was closed, one kept.
    expect(startRepo).toHaveBeenCalledTimes(2);
    expect(closed).toEqual(["/repo/b"]);

    // A second ensure for the same project starts NOTHING new — both paths are cached.
    // (This is the assertion the previous version reset the counter for but never made.)
    await registry.ensureForProject(project());
    expect(startRepo).toHaveBeenCalledTimes(2);

    registry.closeAll();
    // closeAll closed the one retained handle (repo /repo/a).
    expect(closed).toContain("/repo/a");
  });

  it("closeAll() closes a watcher whose start resolves AFTER teardown — no orphan survives", async () => {
    const gate = deferred();
    let lateHandleClosed = false;
    const startRepo = vi.fn(async (): Promise<RepoRehydrationHandle | null> => {
      await gate.promise; // hold the start in flight
      return {
        repoKey: "k",
        close: () => {
          lateHandleClosed = true;
        },
      };
    });
    const registry = createProactiveRehydration({
      store: {} as never,
      generator: {} as never,
      narrate: () => {
        /* ignored */
      },
      startRepo,
    });

    const ensuring = registry.ensureForProject(project({ includedRepoPaths: ["/repo/a"] }));
    registry.closeAll(); // teardown while the start is still awaiting
    gate.resolve(); // the start resolves LATE
    await ensuring;

    // The late handle was closed on arrival, never retained as an orphan.
    expect(lateHandleClosed).toBe(true);
  });

  it("projectRepoPaths falls back to the single open path when no included repos", () => {
    expect(projectRepoPaths(project({ includedRepoPaths: [] }))).toEqual(["/repo/a"]);
    expect(projectRepoPaths(project({ includedRepoPaths: ["/x", "/y"] }))).toEqual(["/x", "/y"]);
  });
});
