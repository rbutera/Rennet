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
 * ⚠️ SCOPE: this keeps the deterministic SNAPSHOT proactive — nothing model-backed.
 *
 * The delta-pass ENGINE (`BaselineAdvanceCoordinator` debounce+coalesce,
 * `startBaselineWatch` fs.watch over the ref tree, and the ProjectSnapshot regen
 * behind `baselineAdvanceDepsFor`) is already built and tested in `@rennet/adapters`.
 * This module is the CALLER the source comment there says "happens in the caller" —
 * the thing that was missing: it starts a watcher per warm repo, brackets the pass
 * with background narration, and tears down cleanly.
 *
 * Design fidelity (see the docsite context-assembly contract): the "proactive
 * update" direction keeps the DETERMINISTIC snapshot rebuild warm and never yields a
 * WRONG review — every context read is gated on content-equality at the review's own
 * pinned base OID (`project-context-reader.ts`, R30) and returns a typed `stale`
 * refusal rather than serving a mismatched map. (Novelty reclassification is a separate,
 * not-yet-wired composition; it is deliberately NOT triggered here.)
 *
 * ⚠️ KNOWN LIMITATION (#143, Codex review): the store holds ONE manifest per repo, so a
 * background advance to a newer tip EVICTS the warm map from a review still pinned to an
 * OLDER base OID — that review's context reads then fail-closed to `stale` (honest,
 * never wrong output) until it re-opens and regenerates at its own OID. So a pass makes
 * a review opened AT the new tip faster, but can DEGRADE (never corrupt) an in-flight
 * older-pinned one. The real fixes — OID-addressable manifests, or suppressing
 * advancement while a review is leased to the prior snapshot — are a follow-on; this
 * ships as a known limitation (Rai's features-over-hardening call). The interaction is
 * pinned by a test so a future "fix" must update it.
 *
 * Two judgement calls, both flagged in the handoff:
 *  - "Don't fight the user": we only keep warm what is ALREADY built — a repo with no
 *    snapshot manifest is skipped, never cold-built in the background. The existing
 *    coordinator already bounds work to one pass at a time at the newest tip.
 *  - "Be visible": the pass narrates on the SAME progress push the processing screen
 *    uses (now WS `progressEvent` frames, #378), under a stable command id, reusing
 *    `ProjectProcessEvent`. No new protocol surface; a renderer indicator is a one-line follow-up.
 */

/** The stable push id background rehydration narration is streamed under. */
export { proactiveRehydrationCommandId } from "@rennet/protocol";

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
  /** The project this repo belongs to — the narration channel's scope. */
  readonly projectId: string;
  readonly repoPath: string;
  /** The confirmed primary branch the initial snapshot was built at (may be absent). */
  readonly explicitBaseRef?: string | undefined;
  readonly store: ProjectSnapshotStore;
  readonly generator: ProjectSnapshotGenerator;
  /** Push a background narration event (the server fans it to every WS client, #378). */
  readonly narrate: (event: ProjectProcessEvent) => void;
  /** A resolve/build error — logged, never thrown into the watcher. */
  readonly onError?: (error: unknown) => void;
  /** Deterministic in-flight novelty reclassification after the structural advance. */
  readonly runNoveltyPass?: (repoKey: string) => Promise<void>;
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
        await deps.runNoveltyPass?.(resolved.repoKey);
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
      // Terminal: cancel first so a queued/debounced notify can never fire a pass
      // AFTER teardown, THEN stop the fs watch so no new notify arrives.
      coordinator.cancel();
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
  /** Narrate ONE project's background pass — the channel is scoped by project. */
  readonly narrate: (projectId: string, event: ProjectProcessEvent) => void;
  readonly onError?: (error: unknown) => void;
  readonly git?: GitExec;
  readonly runNoveltyPass?: StartRepoRehydrationDeps["runNoveltyPass"];
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
  // Paths already accounted for (a live watcher, or one resolved to an already-warm
  // repoKey): a later ensure SKIPS startup entirely rather than starting a watcher and
  // immediately closing it as a duplicate. A path that could NOT be warmed yet (no
  // snapshot) is deliberately NOT cached, so a later ensure — after the project is
  // processed and its manifest exists — retries it.
  const startedPaths = new Set<string>();
  // Guard against a concurrent second `ensureForProject` racing the same path into two
  // starts before either has resolved.
  const inFlight = new Set<string>();
  // Terminal shutdown: once closed, a start that resolves late is closed on arrival and
  // never retained, so teardown can never leak an orphaned watcher.
  let closed = false;

  return {
    ensureForProject: async (project) => {
      if (closed) return;
      for (const repoPath of projectRepoPaths(project)) {
        if (startedPaths.has(repoPath) || inFlight.has(repoPath)) continue;
        inFlight.add(repoPath);
        try {
          const handle = await startRepo({
            projectId: project.id,
            repoPath,
            explicitBaseRef: project.primaryBranch,
            store: deps.store,
            generator: deps.generator,
            narrate: (event) => deps.narrate(project.id, event),
            ...(deps.onError ? { onError: deps.onError } : {}),
            ...(deps.git ? { git: deps.git } : {}),
            ...(deps.runNoveltyPass ? { runNoveltyPass: deps.runNoveltyPass } : {}),
          });
          // No snapshot yet — not cached, so a later ensure retries this path.
          if (!handle) continue;
          // Teardown happened while this start was in flight: close on arrival, never
          // retain (finding: closeAll must be terminal, no late watcher survives it).
          if (closed) {
            handle.close();
            continue;
          }
          // This path is now accounted for — future ensures skip it.
          startedPaths.add(repoPath);
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
      closed = true;
      for (const handle of handles.values()) handle.close();
      handles.clear();
    },
  };
}
