import {
  createLiveCanvasOpsBackend,
  defaultProjectsBaseDir,
  type LiveBackendDeps,
  type LiveReviewBackend,
  snapshotStoreFor,
} from "@rennet/adapters";
import type { ReviewPipelineResult } from "@rennet/core";
import type { Review } from "@rennet/types";

// ─────────────────────────────────────────────────────────────────────────────
// The desktop composition root for the live end-to-end review backend (issue #13).
//
// The composition + snapshot-on-open logic is reusable and lives (tested over a
// real git repo) in `@rennet/adapters`. The app-owned ProjectSnapshot store is the
// LOCAL-FIRST, PATH-KEYED store under `~/.rennet/projects/` (#187/#188): the
// adapters `defaultProjectsBaseDir()` supplies that root and each checkout PATH
// gets its own entry. This module is deliberately electron-free (it takes an
// optional `baseDir` value, defaulted to `defaultProjectsBaseDir()`) so it is unit
// testable without spinning up Electron; `index.ts` injects nothing and inherits
// the `~/.rennet/projects/` default. (Was `<userData>/snapshots` before #188.)
//
// The orchestrator ATTACH (`attachOrchestratorSession`) that consumes this backend
// is a follow-on (wave 2); this wave assembles the live backend so context.map /
// context.file / context.novelty serve real data the moment a review is opened.
// ─────────────────────────────────────────────────────────────────────────────

// Re-exported from the adapters store so the desktop composition (and its tests)
// have one import site for the local-first store + its default base directory.
export { defaultProjectsBaseDir, snapshotStoreFor };

/**
 * Assemble the production `CanvasOpsBackend` for a freshly opened review, using the
 * app-owned local-first snapshot store under `~/.rennet/projects/` (issue #188).
 * `baseDir` defaults to `defaultProjectsBaseDir()`; a test injects a temp dir so it
 * never touches the real home store. Delegates the composition + snapshot-on-open
 * (fail-closed, size-gated) to the adapters composition root.
 */
export function createDesktopReviewBackend(
  review: Review,
  pipeline: ReviewPipelineResult,
  opts?: { readonly baseDir?: string } & Omit<LiveBackendDeps, "store">,
): Promise<LiveReviewBackend> {
  const { baseDir, ...rest } = opts ?? {};
  return createLiveCanvasOpsBackend(review, pipeline, {
    store: snapshotStoreFor(baseDir ?? defaultProjectsBaseDir()),
    ...rest,
  });
}
