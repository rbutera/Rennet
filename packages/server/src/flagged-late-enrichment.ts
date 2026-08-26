import { type RunUiVerificationResult, UI_SURFACE_CLASSIFIER_VERSION } from "@rennet/core";
import type { FlaggedReview } from "@rennet/protocol";
import { applyUiVerification } from "./flagged-ui-verification";

export interface ComposeFlaggedLateEnrichmentInput {
  readonly immediate: FlaggedReview;
  readonly adjudication?: Promise<FlaggedReview> | null;
  readonly uiVerification?: Promise<RunUiVerificationResult> | null;
}

export interface ComposedFlaggedLateEnrichment {
  readonly review: FlaggedReview;
  readonly enrichment: Promise<FlaggedReview> | null;
}

/**
 * Compose independent late enrichments without delaying the initial flagged rows.
 * The transient scheduled bit is the renderer's polling contract; it is set for any
 * late work, not inferred from the shape of the immediate findings.
 */
export function composeFlaggedLateEnrichment(
  input: ComposeFlaggedLateEnrichmentInput,
): ComposedFlaggedLateEnrichment {
  if (input.immediate.status !== "ok") {
    return { review: input.immediate, enrichment: null };
  }
  const scheduled = Boolean(input.adjudication || input.uiVerification);
  if (!scheduled) return { review: input.immediate, enrichment: null };

  const review: FlaggedReview = { ...input.immediate, lateEnrichmentScheduled: true };
  const adjudicated =
    input.adjudication?.catch(() => input.immediate) ?? Promise.resolve(input.immediate);
  const uiVerification = input.uiVerification
    ? input.uiVerification.catch(
        (reason: unknown): RunUiVerificationResult => ({
          observations: [],
          status: {
            status: "unavailable",
            classifierVersion:
              (input.immediate.status === "ok"
                ? input.immediate.uiVerification?.classifierVersion
                : undefined) ?? UI_SURFACE_CLASSIFIER_VERSION,
            reason: reason instanceof Error ? reason.message : String(reason),
          },
        }),
      )
    : Promise.resolve<RunUiVerificationResult | undefined>(undefined);

  const enrichment = Promise.all([adjudicated, uiVerification]).then(
    ([adjudicatedReview, uiResult]) =>
      clearScheduled(
        uiResult ? applyUiVerification(adjudicatedReview, uiResult) : adjudicatedReview,
      ),
  );
  return { review, enrichment };
}

function clearScheduled(review: FlaggedReview): FlaggedReview {
  if (review.status !== "ok") return review;
  const completed: FlaggedReview = { ...review };
  delete completed.lateEnrichmentScheduled;
  return completed;
}
