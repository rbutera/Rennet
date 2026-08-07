import type { RennetBridge } from "@rennet/protocol";
import type { Canvas, CanvasAngle, Review } from "@rennet/types";

/** The five-angle canvas set the canvas workspace renders. */
export type CanvasSet = Record<CanvasAngle, Canvas>;

/**
 * Fetch the live five-angle canvas set for a review over IPC (issue #54). The
 * engine runs the pipeline (decompose → budget-gated angle → ordering → place);
 * this returns the result, or `null` when the pipeline is unavailable or errors.
 * A `null` is the caller's cue to keep the demo fixtures on screen, so the
 * clickable demo never regresses when there is no harness / a real failure.
 */
export async function loadCanvases(
  bridge: RennetBridge,
  review: Review,
): Promise<CanvasSet | null> {
  try {
    const { canvases } = await bridge.invoke("review.canvases", {
      commandId: crypto.randomUUID(),
      reviewId: review.id,
      repoPath: review.repositoryRoot,
    });
    return canvases;
  } catch {
    return null;
  }
}
