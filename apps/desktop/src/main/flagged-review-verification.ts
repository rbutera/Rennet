import { markVerificationUnavailable } from "@rennet/core";
import type { FlaggedReview } from "@rennet/types";

export function projectUnavailableDeepVerification(
  review: FlaggedReview,
  deepReview: boolean,
): FlaggedReview {
  return deepReview ? markVerificationUnavailable(review) : review;
}
