import { type FSWatcher, watch as nodeWatch } from "node:fs";
import { join } from "node:path";
import { execaGit, type GitExec } from "./git-range-diff";
import type { GenerateOptions, ProjectSnapshotGenerator } from "./project-snapshot-generator";
import { resolveBaseRef } from "./project-snapshot-source";
import type { ProjectSnapshotStore } from "./project-snapshot-store";

/**
 * The PROACTIVE delta pass (#143, design §2a) — keep the default-branch map warm
 * as the reference branch moves, WITHOUT ever gating a review.
 *
 * LOCKED: this is a latency optimisation, never a correctness gate. The review
 * path already refuses a stale snapshot (`loadFresh` pins to the patchset base OID
 * and the on-open build serves it synchronously), so the proactive pass can only
 * make a review FASTER, never wrong. It therefore holds no lock a review waits on:
 * `runDeltaPass` re-resolves the default ref, runs the wave-1 incremental path, and
 * advances the store ATOMICALLY — a reader either sees the prior snapshot or the
 * new one, never a half state, and never blocks.
 *
 * Bounded by construction:
 *  - DEBOUNCE: a burst of ref writes resets one timer, so the pass fires once the
 *    burst settles (injectable timers ⇒ deterministic tests, no real fs events).
 *  - COALESCE: only ONE pass runs at a time; notifications arriving mid-pass mark
 *    the run dirty and trigger exactly one more pass afterwards, which re-resolves
 *    the NEWEST tip — a merge train collapses to a single pass at the tip, and
 *    intermediate OIDs are never built.
 *  - NO-OP ON NO MOVEMENT: if the re-resolved OID equals the stored one, no pass runs.
 */

/** The default debounce window for coalescing a burst of ref writes. */
export const DEFAULT_BASELINE_DEBOUNCE_MS = 250;

/** An injectable timer handle (opaque — the coordinator only round-trips it). */
type Handle = unknown;

/** Injectable timers, so the debounce is deterministic under test (no real clock). */
export interface Timers {
  readonly setTimeout: (fn: () => void, ms: number) => Handle;
  readonly clearTimeout: (handle: Handle) => void;
}

const REAL_TIMERS: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The side-effecting seams the coordinator drives — all injectable. */
export interface BaselineAdvanceDeps {
  /** Re-resolve the current default-branch OID (the tip). */
  readonly resolveCurrentBaseOid: () => Promise<string>;
  /** The OID the stored snapshot is currently at (null ⇒ no snapshot yet). */
  readonly storedBaseOid: () => string | null;
  /** Run the incremental delta pass to the current tip and advance the store atomically. */
  readonly runDeltaPass: () => Promise<void>;
  readonly debounceMs?: number;
  readonly timers?: Timers;
  /** Observability: a delta pass ran (or was skipped when `toOid === fromOid`). */
  readonly onPass?: (info: { readonly fromOid: string | null; readonly toOid: string }) => void;
  /** A resolve/build error — logged, never thrown into the watcher (it must not crash). */
  readonly onError?: (error: unknown) => void;
}

/**
 * The testable coalescing core. `notify()` is called by the event source on any ref
 * change; the coordinator debounces, then drains — running at most one pass at a
 * time and coalescing a burst to a single pass at the newest tip.
 */
export class BaselineAdvanceCoordinator {
  private pending: Handle | null = null;
  private running = false;
  private dirty = false;
  private draining: Promise<void> | null = null;
  private closed = false;

  private readonly debounceMs: number;
  private readonly timers: Timers;

  constructor(private readonly deps: BaselineAdvanceDeps) {
    this.debounceMs = deps.debounceMs ?? DEFAULT_BASELINE_DEBOUNCE_MS;
    this.timers = deps.timers ?? REAL_TIMERS;
  }

  /** A ref may have moved. Debounced: the burst collapses to a single scheduled drain. */
  notify(): void {
    if (this.closed) return;
    if (this.pending !== null) this.timers.clearTimeout(this.pending);
    this.pending = this.timers.setTimeout(() => {
      this.pending = null;
      this.trigger();
    }, this.debounceMs);
  }

  /**
   * Terminal shutdown: clear any pending debounced drain and refuse all further
   * triggers, so a queued notify can never fire a pass AFTER the owner has torn the
   * watcher down. An already-running drain is left to settle (it was legitimately in
   * flight); the closed flag stops it re-looping and blocks any new pass.
   */
  cancel(): void {
    this.closed = true;
    if (this.pending !== null) {
      this.timers.clearTimeout(this.pending);
      this.pending = null;
    }
  }

  /** Resolves once any in-flight drain settles (test seam; no-op when idle). */
  async whenIdle(): Promise<void> {
    await this.draining;
  }

  private trigger(): void {
    if (this.closed) return;
    // Coalesce: a drain already running just marks the run dirty (one more pass
    // afterwards at the newest tip); we never start a second concurrent drain.
    if (this.running) {
      this.dirty = true;
      return;
    }
    this.running = true;
    this.draining = this.drain().finally(() => {
      this.running = false;
      this.draining = null;
    });
  }

  private async drain(): Promise<void> {
    do {
      this.dirty = false;
      try {
        const toOid = await this.deps.resolveCurrentBaseOid();
        const fromOid = this.deps.storedBaseOid();
        // No movement, no work.
        if (toOid !== fromOid) {
          await this.deps.runDeltaPass();
          this.deps.onPass?.({ fromOid, toOid });
        }
      } catch (error) {
        // The watcher must never crash the host process; surface and continue.
        this.deps.onError?.(error);
      }
    } while (this.dirty && !this.closed);
  }
}

/**
 * Wire the coordinator to the real store + generator: `runDeltaPass` re-resolves
 * the default ref and runs the incremental generate+advance; `resolveCurrentBaseOid`
 * re-resolves the tip; `storedBaseOid` reads the stored manifest. `repoRoot` is the
 * repo top-level; `repoKey` its store key.
 */
export function baselineAdvanceDepsFor(opts: {
  readonly repoRoot: string;
  readonly repoKey: string;
  readonly store: ProjectSnapshotStore;
  readonly generator: ProjectSnapshotGenerator;
  readonly git?: GitExec;
  readonly debounceMs?: number;
  readonly timers?: Timers;
  /**
   * The confirmed default-branch ref the initial snapshot was built at (the
   * project's primary branch). Threaded into BOTH the tip re-resolution and the
   * regen so the proactive pass tracks and rebuilds at exactly the ref the initial
   * dump used — otherwise `resolveBaseRef` falls back to origin/HEAD, which can
   * differ from the primary branch and churn a spurious pass on every notify.
   */
  readonly explicitBaseRef?: GenerateOptions["explicitBaseRef"];
  /** Live build-stage narration for the regen (surfaced as background progress). */
  readonly onProgress?: GenerateOptions["onProgress"];
  readonly onPass?: BaselineAdvanceDeps["onPass"];
  readonly onError?: BaselineAdvanceDeps["onError"];
}): BaselineAdvanceDeps {
  const git = opts.git ?? execaGit;
  const withRef = opts.explicitBaseRef ? { explicitBaseRef: opts.explicitBaseRef } : {};
  return {
    resolveCurrentBaseOid: async () =>
      (await resolveBaseRef(opts.repoRoot, { git, ...withRef })).baseOid,
    storedBaseOid: () => opts.store.loadManifest(opts.repoKey)?.baseOid ?? null,
    runDeltaPass: async () => {
      await opts.generator.generate(opts.repoRoot, {
        ...withRef,
        ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
      });
    },
    debounceMs: opts.debounceMs,
    timers: opts.timers,
    onPass: opts.onPass,
    onError: opts.onError,
  };
}

/** A handle to stop the fs watchers. */
export interface BaselineWatchHandle {
  close(): void;
}

/** Injectable `fs.watch` (defaults to node's) so the wiring is testable/mockable. */
export type WatchFn = (path: string, listener: () => void) => { close(): void };

const REAL_WATCH: WatchFn = (path, listener) => {
  const watcher: FSWatcher = nodeWatch(path, { persistent: false, recursive: true }, () =>
    listener(),
  );
  // fs.watch handles emit "error" asynchronously (e.g. the watched dir vanishes, or
  // the WSL 9P bridge misbehaves); unhandled, that crashes the whole daemon — the
  // same class of bug as the repo-watcher crash loop observed 2026-08-19. Degrade to
  // a closed watcher instead: baseline advance falls back to the next explicit check.
  watcher.on("error", () => {
    try {
      watcher.close();
    } catch {
      // best-effort teardown
    }
  });
  return { close: () => watcher.close() };
};

/**
 * Start the event-driven baseline watch (design §2, the shared trigger): watch the
 * git common dir's `refs/heads/` tree (LOCAL branch tips — a commit, rebase, or reset
 * on the default branch), the `refs/remotes/origin/` tree (a fetch/pull advancing the
 * remote default), and the `packed-refs` file (either, once packed), calling
 * `coordinator.notify()` on any change. Best-effort and OPTIONAL — a path that
 * cannot be watched (e.g. no remote refs yet) is skipped, never fatal; the coordinator
 * still works driven by any other trigger (review-open remains the always-correct
 * fallback). `fs.watch` is race-prone, which is exactly why the coordinator debounces
 * and coalesces rather than trusting each event.
 */
export function startBaselineWatch(
  gitCommonDir: string,
  coordinator: BaselineAdvanceCoordinator,
  options: { readonly watch?: WatchFn } = {},
): BaselineWatchHandle {
  const watch = options.watch ?? REAL_WATCH;
  const notify = () => coordinator.notify();
  const watchers: { close(): void }[] = [];
  for (const target of [
    join(gitCommonDir, "refs", "heads"),
    join(gitCommonDir, "refs", "remotes", "origin"),
    join(gitCommonDir, "packed-refs"),
  ]) {
    try {
      watchers.push(watch(target, notify));
    } catch {
      // A missing target (no remote refs / no packed-refs yet) is fine — skip it.
    }
  }
  return {
    close: () => {
      for (const watcher of watchers) {
        try {
          watcher.close();
        } catch {
          // best-effort teardown
        }
      }
    },
  };
}
