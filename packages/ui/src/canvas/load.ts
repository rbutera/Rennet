import type { RennetBridge } from "@rennet/protocol";
import type {
  Canvas,
  CanvasAngle,
  ContextManifest,
  DecisionsRunStatus,
  ElementDiffs,
  Review,
  ReviewEngine,
  ReviewNarration,
} from "@rennet/types";

/** The five-angle canvas set the canvas workspace renders. */
export type CanvasSet = Record<CanvasAngle, Canvas>;

/**
 * The live canvas set plus its real per-element diff map (issue #60), the roll-up
 * narration (issue #70), and the engine provenance (real-AI-default). All are
 * delivered ALONGSIDE the canvases: the diffs so zooming into an element shows real
 * code, the narration so each altitude carries the agent's account, and `engine`
 * so the UI can tell a real AI review from the deterministic mechanical outline and
 * say so loudly. `narration` and `engine` are optional (a desktop build that
 * predates either omits it — the UI then shows the honest pending state and makes
 * no engine claim).
 */
export interface LoadedCanvases {
  canvases: CanvasSet;
  elementDiffs: ElementDiffs;
  narration?: ReviewNarration;
  engine?: ReviewEngine;
  /**
   * How the Decisions runner ran (issue #137/#160). Present when the engine reports
   * it; absent ⇒ the UI defaults to `ok`. Carried so the Decisions lens can paint a
   * FAILED runner distinctly from a review that ran and discerned nothing — without
   * it, "the decisions pass crashed" renders identical to "found nothing".
   */
  decisionsRun?: DecisionsRunStatus;
  /**
   * The composition manifest (issue #30): the deterministic, byte-budgeted context
   * Rennet assembled for this review, recorded per document. Optional — absent ⇒ the inspector shows an honest "not
   * available", never a fabricated stand-in (Rule Zero).
   */
  contextManifest?: ContextManifest;
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
    // Running the harness is Rennet's whole job — it just runs. No consent token,
    // no permission mode: opening Canvases composes the model turn directly.
    const { canvases, elementDiffs, narration, engine, decisionsRun, contextManifest } =
      await bridge.invoke("review.canvases", {
        commandId: crypto.randomUUID(),
        reviewId: review.id,
        repoPath: review.repositoryRoot,
      });
    return {
      canvases,
      elementDiffs,
      ...(narration ? { narration } : {}),
      ...(engine ? { engine } : {}),
      ...(decisionsRun ? { decisionsRun } : {}),
      ...(contextManifest ? { contextManifest } : {}),
    };
  } catch {
    return null;
  }
}
