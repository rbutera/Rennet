import type { FileChangeStatus, PatchFile, Review } from "@rennet/protocol";

// ─────────────────────────────────────────────────────────────────────────────
// The patchset-projection seam (C6, reconciliation 2) — the ONE place the diff surface
// reads changed files off a resolved review. The projection already arrived through
// `review.load` in `routes/slug.ts`'s `useSlugResolution`; this module never issues a
// command of its own. If a dedicated patchset-projection command distinct from the
// full-review read is ever introduced — B3 and B4 both landed without one — THIS file is
// the only one that changes, exactly how C4 isolated the span-read behind `citations.ts`.
//
// The raw diff needs no filesystem and no span-read: `PatchFile.patch` carries its own
// unified-diff text inline. This module (and `diff-parse.ts`) touch no filesystem module —
// the review import-boundary test guards that executably.
// ─────────────────────────────────────────────────────────────────────────────

/** Re-exported so diff consumers type against `@rennet/protocol` through this one seam,
 *  never reaching into `delta/citations` directly. */
export type { FileChangeStatus, PatchFile } from "@rennet/protocol";

/**
 * The active patchset's changed files, from a resolved `Review`. The active patchset is
 * selected by `activePatchsetId`; an id that matches no patchset (or a patchset with no
 * files) yields `[]` — an honest empty surface, never a crash.
 */
export function activePatchsetFiles(review: Review): readonly PatchFile[] {
  return review.patchsets.find((p) => p.id === review.activePatchsetId)?.files ?? [];
}

/** Whether a status carries a rename source (`previousPath` is meaningful). */
export function isRename(status: FileChangeStatus): boolean {
  return status === "renamed";
}
