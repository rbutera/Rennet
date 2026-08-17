import type { RunUiVerificationResult } from "@rennet/core";
import type { FlaggedReview } from "@rennet/types";

export interface ImmediateUiVerificationInput {
  readonly touchesUi: boolean;
  readonly classifierVersion: number;
  readonly deepReview: boolean;
  readonly verifierAvailable: boolean;
}

/** Stamp the honest immediate state before any slow verify-ui turn can finish. */
export function applyImmediateUiVerification(
  review: FlaggedReview,
  input: ImmediateUiVerificationInput,
): FlaggedReview {
  if (!input.touchesUi) {
    return applyUiVerification(review, {
      observations: [],
      status: { status: "not-ui", classifierVersion: input.classifierVersion },
    });
  }
  if (!input.deepReview) return review;
  return applyUiVerification(review, {
    observations: [],
    status: input.verifierAvailable
      ? { status: "pending", classifierVersion: input.classifierVersion }
      : {
          status: "unavailable",
          classifierVersion: input.classifierVersion,
          reason: "verifier unavailable",
        },
  });
}

/**
 * Fold a verify-ui result (issue #183) into a flagged review: append the pass's
 * observations to the findings (so they flow through the SAME lens, disposition,
 * publish, and delta-carry machinery as every other finding — no new disposition
 * surface) and stamp the additive `uiVerification` status. Pure over the review; a
 * `failed` review passes through untouched (verify-ui runs only on an ok surface).
 *
 * It is purely additive and NEVER a gate (Rule Zero): the status and the appended
 * findings are informational, and sign/publish never read `uiVerification`. This is
 * the one place verify-ui touches the review, extracted so the wiring is unit-tested
 * off-Electron (mirroring `stampBlockingStates` / `projectUnavailableDeepVerification`).
 */
export function applyUiVerification(
  review: FlaggedReview,
  result: RunUiVerificationResult,
): FlaggedReview {
  if (review.status !== "ok") return review;
  return {
    ...review,
    findings: [...review.findings, ...result.observations],
    uiVerification: result.status,
  };
}
