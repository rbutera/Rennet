import type { RennetBridge } from "@rennet/protocol";
import type { Canvas, CanvasAngle, ElementDiffs, Review, ReviewNarration } from "@rennet/types";

/** The five-angle canvas set the canvas workspace renders. */
export type CanvasSet = Record<CanvasAngle, Canvas>;

/**
 * The live canvas set plus its real per-element diff map (issue #60) and the
 * roll-up narration (issue #70). Both are delivered ALONGSIDE the canvases: the
 * diffs so zooming into an element shows real code, the narration so each altitude
 * above a chunk carries the agent's account. `narration` is optional (a desktop
 * build that predates it omits it — the UI then shows the honest pending state).
 */
export interface LoadedCanvases {
  canvases: CanvasSet;
  elementDiffs: ElementDiffs;
  narration?: ReviewNarration;
}

/**
 * Fetch the live five-angle canvas set + real element diffs for a review over IPC
 * (issue #54, #60). The engine runs the pipeline (decompose → budget-gated angle
 * → ordering → place) and slices the real diffs; this returns the result, or
 * `null` when the pipeline is unavailable or errors. A `null` is the caller's cue
 * to keep the demo fixtures on screen, so the clickable demo never regresses when
 * there is no harness / a real failure.
 */
export async function loadCanvases(
  bridge: RennetBridge,
  review: Review,
  consent: boolean,
): Promise<LoadedCanvases | null> {
  try {
    const { canvases, elementDiffs, narration } = await bridge.invoke("review.canvases", {
      commandId: crypto.randomUUID(),
      reviewId: review.id,
      repoPath: review.repositoryRoot,
      // The #58/#103 one-shot harness-run consent (bead workspace-j98dt): the
      // caller passes whether the run is permitted for THIS review. The main
      // process independently enforces the gate; this signal carries the user's
      // per-run allow (or "the mode does not ask") across the IPC boundary.
      consent,
    });
    return { canvases, elementDiffs, ...(narration ? { narration } : {}) };
  } catch {
    return null;
  }
}
