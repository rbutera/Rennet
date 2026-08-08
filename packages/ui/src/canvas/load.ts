import type { RennetBridge } from "@rennet/protocol";
import type {
  Canvas,
  CanvasAngle,
  ElementDiffs,
  NarrativeProgressEvent,
  Review,
  ReviewNarration,
} from "@rennet/types";

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
  /** Resumable deterministic stage-three summary (issue #71). */
  progress?: NarrativeProgressEvent[];
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
  authorization: string | null,
): Promise<LoadedCanvases | null> {
  try {
    const { canvases, elementDiffs, narration, progress } = await bridge.invoke("review.canvases", {
      commandId: crypto.randomUUID(),
      reviewId: review.id,
      repoPath: review.repositoryRoot,
      // The #58/#103 harness-run authorization (bead workspace-fyvxb): under a
      // mode that asks, the caller relays the single-use token MAIN minted for
      // THIS review via `harness.requestConsent`; MAIN consumes it before the
      // spend. Omitted under auto/bypass (no token required) — the field is only
      // included when the caller holds one, never asserted as a bare boolean.
      ...(authorization ? { authorization } : {}),
    });
    return {
      canvases,
      elementDiffs,
      ...(narration ? { narration } : {}),
      ...(progress ? { progress } : {}),
    };
  } catch {
    return null;
  }
}
