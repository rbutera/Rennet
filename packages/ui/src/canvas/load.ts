import type { RennetBridge } from "@rennet/protocol";
import type { Canvas, CanvasAngle, ElementDiffs, Review } from "@rennet/types";

/** The five-angle canvas set the canvas workspace renders. */
export type CanvasSet = Record<CanvasAngle, Canvas>;

/**
 * The live canvas set plus its real per-element diff map (issue #60). The diffs
 * are delivered ALONGSIDE the canvases so zooming into an element shows real code
 * (sliced verbatim from the captured patch), not the `demoDiff` fixture.
 */
export interface LoadedCanvases {
  canvases: CanvasSet;
  elementDiffs: ElementDiffs;
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
): Promise<LoadedCanvases | null> {
  try {
    const { canvases, elementDiffs } = await bridge.invoke("review.canvases", {
      commandId: crypto.randomUUID(),
      reviewId: review.id,
      repoPath: review.repositoryRoot,
    });
    return { canvases, elementDiffs };
  } catch {
    return null;
  }
}
