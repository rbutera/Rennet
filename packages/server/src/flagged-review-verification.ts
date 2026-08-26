import { markVerificationUnavailable } from "@rennet/core";
import type { FlaggedReview } from "@rennet/protocol";

export function projectUnavailableDeepVerification(
  review: FlaggedReview,
  deepReview: boolean,
): FlaggedReview {
  return deepReview ? markVerificationUnavailable(review) : review;
}
