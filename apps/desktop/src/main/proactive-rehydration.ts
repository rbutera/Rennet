import { basename, isAbsolute, resolve } from "node:path";
import {
  BaselineAdvanceCoordinator,
  type BaselineAdvanceDeps,
  type BaselineWatchHandle,
  baselineAdvanceDepsFor,
  execaGit,
  type GitExec,
  type ProjectSnapshotGenerator,
  type ProjectSnapshotStore,
  resolveBaseRef,
  startBaselineWatch,
  type Timers,
  type WatchFn,
} from "@rennet/adapters";
import type { ProcessedRepoSummary, Project, ProjectProcessEvent } from "@rennet/protocol";

/**
 * Proactive rehydration — the SNAPSHOT half of issue #143. Keep a project's
 * deterministic Repo Map (the model-free ProjectSnapshot) warm as its reference
 * branch moves, so a review opened at the new tip reads a fresh structural picture
 * (context.map / context.file) without an on-open rebuild.
 *
 * ⚠️ SCOPE: this makes the SNAPSHOT proactive. It does NOT keep the LLM knowledge
 * layer (context.knowledge) warm — that layer is not wired into desktop at all, so
 * there is no set to delta from. #143's knowledge half is untouched by this.
 *
 * The delta-pass ENGINE (`BaselineAdvanceCoordinator` debounce+coalesce,
 * `startBaselineWatch` fs.watch over the ref tree, and the ProjectSnapshot regen
 * behind `baselineAdvanceDepsFor`) is already built and tested in `@rennet/adapters`.
 * This module is the CALLER the source comment there says "happens in the caller" —
 * the thing that was missing: it starts a watcher per warm repo, brackets the pass
 * with background narration, and tears down cleanly.
 *
 * Design fidelity (R54, `Rennet Orchestrator Context Access.md`): the "proactive
 * update" direction keeps the DETERMINISTIC snapshot rebuild warm and NEVER blocks a
 * review — the review path pins to its patchset base OID and refuses a stale snapshot
 * synchronously, so a background regen can only make a later review faster, never
 * wrong. (The LLM knowledge layer is a separate, not-yet-wired composition; it is
 * deliberately NOT triggered here.)
 *
 * Two judgement calls, both flagged in the handoff:
 *  - "Don't fight the user": we only keep warm what is ALREADY built — a repo with no
 *    snapshot manifest is skipped, never cold-built in the background. The existing
 *    coordinator already bounds work to one pass at a time at the newest tip.
 *  - "Be visible": the pass narrates on the SAME `rennet:progress` push the processing
 *    screen uses, under a stable command id, reusing `ProjectProcessEvent`. No new
 *    protocol/preload surface; a renderer indicator is a one-line follow-up.
 */

/** The stable push id background rehydration narration is streamed under. */
export const PROACTIVE_REHYDRATION_COMMAND_ID = "proactive:rehydration";

/** A started per-repo watcher. `close()` stops the fs watch (idempotent). */
export interface RepoRehydrationHandle {
  /** The store key (`escapePath(realpath(top-level))`) the watcher is warming. */
  readonly repoKey: string;
  close(): void;
}

/** Resolve `{ repoKey, root, gitCommonDir }` for a repo path at the given ref. */
export interface ResolvedRepo {
  readonly repoKey: string;
  readonly root: string;
  readonly gitCommonDir: string;
}

/** The absolute git common dir for `root` (`rev-parse --git-common-dir`, path-resolved). */
export async function resolveGitCommonDir(root: string, git: GitExec): Promise<string> {
  const raw = (await git(root, ["rev-parse", "--git-common-dir"], { reject: true })).trim();
  return isAbsolute(raw) ? raw : resolve(root, raw);
}

async function defaultResolveRepo(
  repoPath: string,
  explicitBaseRef: string | undefined,
  git: GitExec,
): Promise<ResolvedRepo> {
  const base = await resolveBaseRef(repoPath, {
    git,
    ...(explicitBaseRef ? { explicitBaseRef } : {}),
  });
  const gitCommonDir = await resolveGitCommonDir(base.root, git);
  return { repoKey: base.repoKey, root: base.root, gitCommonDir };
}

/** Inputs for starting one repo's proactive rehydration watcher. */
export interface StartRepoRehydrationDeps {
  readonly repoPath: string;
  /** The confirmed primary branch the initial snapshot was built at (may be absent). */
  readonly explicitBaseRef?: string | undefined;
  readonly store: ProjectSnapshotStore;
  readonly generator: ProjectSnapshotGenerator;
  /** Push a background narration event (the app broadcasts it on `rennet:progress`). */
  readonly narrate: (event: ProjectProcessEvent) => void;
  /** A resolve/build error — logged, never thrown into the watcher. */
  readonly onError?: (error: unknown) => void;
  readonly git?: GitExec;
  // ── test seams ─────────────────────────────────────────────────────────────
  readonly watch?: WatchFn;
  readonly timers?: Timers;
  readonly debounceMs?: number;
  readonly resolveRepo?: (repoPath: string, explicitBaseRef?: string) => Promise<ResolvedRepo>;
}

/**
 * Start ONE repo's watcher. Returns a handle, or `null` when the repo has no snapshot
 * to keep warm (never built) or its base ref cannot be resolved — either way there is
 * nothing to rehydrate, so we do not cold-build in the background. Never throws.
 */
export async function startRepoRehydration(
  deps: StartRepoRehydrationDeps,
): Promise<RepoRehydrationHandle | null> {
  const git = deps.git ?? execaGit;
  const resolveRepo = deps.resolveRepo ?? ((path, ref) => defaultResolveRepo(path, ref, git));

  let resolved: ResolvedRepo;
  try {
    resolved = await resolveRepo(deps.repoPath, deps.explicitBaseRef);
  } catch (error) {
    deps.onError?.(error);
    return null;
  }

  // Keep warm only what is already built — never cold-build a snapshot in the
  // background for a repo the user has not processed.
  if (!deps.store.loadManifest(resolved.repoKey)) return null;

  const repoLabel = basename(resolved.root) || resolved.root;

  const base = baselineAdvanceDepsFor({
    repoRoot: resolved.root,
    repoKey: resolved.repoKey,
    store: deps.store,
    generator: deps.generator,
    git,
    ...(deps.explicitBaseRef ? { explicitBaseRef: deps.explicitBaseRef } : {}),
    ...(deps.debounceMs === undefined ? {} : { debounceMs: deps.debounceMs }),
    ...(deps.timers ? { timers: deps.timers } : {}),
  });

  // Reuse the base-ref + manifest glue from `baselineAdvanceDepsFor`, but own the
  // regen so we can bracket it with narration and surface the real per-repo counts.
  const advanceDeps: BaselineAdvanceDeps = {
    ...base,
    runDeltaPass: async () => {
      deps.narrate({ kind: "repo-start", repo: repoLabel, index: 1, total: 1 });
      try {
        const result = await deps.generator.generate(resolved.root, {
          ...(deps.explicitBaseRef ? { explicitBaseRef: deps.explicitBaseRef } : {}),
          onProgress: (progress) =>
            deps.narrate({
              kind: "stage",
              repo: repoLabel,
              stage: progress.stage,
              note: progress.note,
              ...(progress.detail === undefined ? {} : { detail: progress.detail }),
            }),
        });
        const summary: ProcessedRepoSummary = {
          repo: repoLabel,
          path: resolved.root,
          ok: true,
          files: result.fileCount,
          symbols: result.symbolCount,
          references: result.referenceCount,
          reusedSymbols: result.reusedSymbolShards,
          baseRef: result.manifest.baseRef,
        };
        deps.narrate({ kind: "repo-done", repo: repoLabel, summary });
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        deps.narrate({ kind: "repo-error", repo: repoLabel, message });
        // Rethrow so the coordinator treats it as a failed pass: the manifest is NOT
        // advanced, so the next ref move retries, and the prior map stays visible.
        throw reason;
      }
    },
    onError: (error) => deps.onError?.(error),
  };

  const coordinator = new BaselineAdvanceCoordinator(advanceDeps);
  const watchHandle: BaselineWatchHandle = startBaselineWatch(
    resolved.gitCommonDir,
    coordinator,
    deps.watch ? { watch: deps.watch } : {},
  );
  let closed = false;
  return {
    repoKey: resolved.repoKey,
    close: () => {
      if (closed) return;
      closed = true;
      watchHandle.close();
    },
  };
}

/** The registry that owns every live per-repo watcher, keyed by repo store key. */
export interface ProactiveRehydration {
  /** Start watchers for every already-built repo in the project (idempotent per repoKey). */
  ensureForProject(project: Project): Promise<void>;
  /** Stop and forget every watcher. */
  closeAll(): void;
}

/** Shared inputs for the registry (a per-repo starter is injectable for tests). */
export interface ProactiveRehydrationDeps {
  readonly store: ProjectSnapshotStore;
  readonly generator: ProjectSnapshotGenerator;
  readonly narrate: (event: ProjectProcessEvent) => void;
  readonly onError?: (error: unknown) => void;
  readonly git?: GitExec;
  /** Test seam: the per-repo starter (defaults to `startRepoRehydration`). */
  readonly startRepo?: (deps: StartRepoRehydrationDeps) => Promise<RepoRehydrationHandle | null>;
}

/** The repo paths a project processes — its included repos, or its single open path. */
export function projectRepoPaths(project: Project): string[] {
  return project.includedRepoPaths && project.includedRepoPaths.length > 0
    ? project.includedRepoPaths
    : [project.openPath || project.path];
}

/**
 * Build the registry. Call `ensureForProject` at launch for every persisted project
 * and again after each `project.process`; both are idempotent by repoKey, so a repo
 * that is already warm is never double-watched. Call `closeAll` on app teardown.
 */
export function createProactiveRehydration(deps: ProactiveRehydrationDeps): ProactiveRehydration {
  const startRepo = deps.startRepo ?? startRepoRehydration;
  const handles = new Map<string, RepoRehydrationHandle>();
  // Guard against a concurrent second `ensureForProject` racing a not-yet-registered
  // repoKey into two watchers: remember paths we have a start in flight for.
  const inFlight = new Set<string>();

  return {
    ensureForProject: async (project) => {
      for (const repoPath of projectRepoPaths(project)) {
        if (inFlight.has(repoPath)) continue;
        inFlight.add(repoPath);
        try {
          const handle = await startRepo({
            repoPath,
            explicitBaseRef: project.primaryBranch,
            store: deps.store,
            generator: deps.generator,
            narrate: deps.narrate,
            ...(deps.onError ? { onError: deps.onError } : {}),
            ...(deps.git ? { git: deps.git } : {}),
          });
          if (!handle) continue;
          // Another path may have resolved to the same repoKey (shared common dir):
          // keep the first, close the duplicate.
          if (handles.has(handle.repoKey)) {
            handle.close();
            continue;
          }
          handles.set(handle.repoKey, handle);
        } catch (error) {
          deps.onError?.(error);
        } finally {
          inFlight.delete(repoPath);
        }
      }
    },
    closeAll: () => {
      for (const handle of handles.values()) handle.close();
      handles.clear();
    },
  };
}
