import type { buildReviewCanvases } from "@rennet/core";
import type { CouncilHarnessId } from "@rennet/types";

// ─────────────────────────────────────────────────────────────────────────────
// Review pipeline input assembly (issue #35, F4 — the composition boundary).
//
// The desktop composition hands `buildReviewCanvases` its input here, in ONE pure
// place, so the wiring is testable off-Electron: the CODEOWNERS-overlap signal was
// dead in the real app because the composition never threaded `ownership`, and a
// green LOADER test could not catch that — only a test at THIS layer, where the
// object is handed to the pipeline, reddens when the property is dropped.
//
// `ownership` and `installed` are REQUIRED parameters (not optional), so dropping
// `ownership` at the call site is a TYPE error and dropping it from the returned
// object is caught by the guard — both halves of the original bug are closed.
// ─────────────────────────────────────────────────────────────────────────────

/** The full input `buildReviewCanvases` consumes (derived, so it cannot drift). */
type ReviewPipelineInput = Parameters<typeof buildReviewCanvases>[0];

/** The resolved pieces the desktop composition assembles for one review. */
export interface ReviewPipelineInputParts {
  readonly reviewId: ReviewPipelineInput["reviewId"];
  readonly patchset: ReviewPipelineInput["patchset"];
  readonly dispositions: ReviewPipelineInput["dispositions"];
  /** The review's CODEOWNERS rules — REQUIRED so a dropped resolve is a type error. */
  readonly ownership: NonNullable<ReviewPipelineInput["ownership"]>;
  /**
   * The fan-in index (#200) — OPTIONAL, because absence is a HONEST state (the reference
   * index is not populated for this review) that surfaces as a NOT-ASSESSED chip, not a
   * silent zero. Unlike `ownership` it cannot be required; the wire is guarded by the
   * seam test instead (a supplied index must reach the pipeline input).
   */
  readonly fanIn?: ReviewPipelineInput["fanIn"];
  /** The honestly-probed installed harness set (Claude / Codex). */
  readonly installed: readonly CouncilHarnessId[];
  readonly decisionDocs: ReviewPipelineInput["decisionDocs"];
  readonly budget: ReviewPipelineInput["budget"];
  readonly codexPort?: ReviewPipelineInput["codexPort"];
  readonly runDecompositionTurn?: ReviewPipelineInput["runDecompositionTurn"];
  readonly runOrderingTurn?: ReviewPipelineInput["runOrderingTurn"];
  readonly runNarrationTurn?: ReviewPipelineInput["runNarrationTurn"];
  readonly assembledContext?: ReviewPipelineInput["assembledContext"];
  readonly onSend?: ReviewPipelineInput["onSend"];
}

/**
 * Assemble the `buildReviewCanvases` input from the composition's resolved pieces.
 * A pure passthrough with the optional model seats spread only when present — the
 * one place `ownership` reaches the pipeline, so the F4 guard can sit exactly here.
 */
export function buildReviewCanvasesInput(parts: ReviewPipelineInputParts): ReviewPipelineInput {
  return {
    reviewId: parts.reviewId,
    patchset: parts.patchset,
    dispositions: parts.dispositions,
    ownership: parts.ownership,
    ...(parts.fanIn ? { fanIn: parts.fanIn } : {}),
    council: { availability: { installed: [...parts.installed] } },
    decisionDocs: parts.decisionDocs,
    budget: parts.budget,
    ...(parts.codexPort ? { codexPort: parts.codexPort } : {}),
    ...(parts.runDecompositionTurn ? { runDecompositionTurn: parts.runDecompositionTurn } : {}),
    ...(parts.runOrderingTurn ? { runOrderingTurn: parts.runOrderingTurn } : {}),
    ...(parts.runNarrationTurn ? { runNarrationTurn: parts.runNarrationTurn } : {}),
    ...(parts.assembledContext === undefined ? {} : { assembledContext: parts.assembledContext }),
    ...(parts.onSend ? { onSend: parts.onSend } : {}),
  };
}
