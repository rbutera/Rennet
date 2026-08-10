import { join } from "node:path";
import {
  createLiveCanvasOpsBackend,
  type LiveBackendDeps,
  type LiveReviewBackend,
  ProjectSnapshotStore,
} from "@rennet/adapters";
import type { ReviewPipelineResult } from "@rennet/core";
import type { Review } from "@rennet/types";

// ─────────────────────────────────────────────────────────────────────────────
// The desktop composition root for the live end-to-end review backend (issue #13).
//
// The composition + snapshot-on-open logic is reusable and lives (tested over a
// real git repo) in `@rennet/adapters`. The ONLY app-specific decision here is
// WHERE the app-owned ProjectSnapshot store lives — `app.getPath("userData")/
// snapshots`, exactly like the sibling file stores (R27/R55). This module is
// deliberately electron-free (it takes `userDataDir` as a value) so it is unit
// testable without spinning up Electron; `index.ts` passes `app.getPath("userData")`.
//
// The orchestrator ATTACH (`attachOrchestratorSession`) that consumes this backend
// is a follow-on (wave 2); this wave assembles the live backend so context.map /
// context.file / context.novelty serve real data the moment a review is opened.
// ─────────────────────────────────────────────────────────────────────────────

/** The app-owned ProjectSnapshot store under the Electron userData directory. */
export function snapshotStoreFor(userDataDir: string): ProjectSnapshotStore {
  return new ProjectSnapshotStore(join(userDataDir, "snapshots"));
}

/**
 * Assemble the production `CanvasOpsBackend` for a freshly opened review, using an
 * app-owned snapshot store under `userDataDir`. Delegates the composition +
 * snapshot-on-open (fail-closed, size-gated) to the adapters composition root.
 */
export function createDesktopReviewBackend(
  review: Review,
  pipeline: ReviewPipelineResult,
  opts: { readonly userDataDir: string } & Omit<LiveBackendDeps, "store">,
): Promise<LiveReviewBackend> {
  const { userDataDir, ...rest } = opts;
  return createLiveCanvasOpsBackend(review, pipeline, {
    store: snapshotStoreFor(userDataDir),
    ...rest,
  });
}
