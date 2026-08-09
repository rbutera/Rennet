import type { FlaggedReview } from "@rennet/types";

/**
 * The Flagged lens substrate (issue #138), STUBBED for this wave.
 *
 * The Flagged lens reaches the automated review layer through the typed boundary;
 * behind it the live finding-generation RUNNER and the dual-review aggregation
 * that turns real reviews into `finding` docs are NOT wired yet (they sequence
 * with #32's finding schema and #41's disagreement machinery). Rather than invent
 * that backend, this fixture supplies a deterministic set that exercises EVERY
 * state the lens renders — a HIGH flag both models concur on, a MEDIUM flag the
 * models DISAGREE on (each answer shown side by side), and a LOW flag both concur
 * on. The surface derives ordering, the agreement flare, and the anchor jump from
 * this raw shape exactly as it will from live findings (prototype frame 09).
 *
 * Live wiring is the follow-up; the boundary here is real.
 */
export function flaggedReviewFixture(): FlaggedReview {
  return {
    status: "ok",
    findings: [
      {
        findingId: "finding-money-circuit",
        anchor: "rennet:hunk/budget-consume-1",
        summary: "The invocation budget is not consumed before the model call (money circuit)",
        severity: "high",
        agreement: { kind: "concur", agree: 3, total: 3 },
      },
      {
        findingId: "finding-lossy-carry",
        anchor: "rennet:hunk/lossy-carry-2",
        summary: "A span disposition can be re-anchored over a truncated patch",
        severity: "medium",
        agreement: {
          kind: "disagree",
          answers: [
            {
              model: "Claude",
              answer:
                "The re-anchor path lacks the patchTruncated floor, so a truncated span is carried — a real leak.",
            },
            {
              model: "Codex",
              answer:
                "The relevance judge re-derives the span before carry, so the truncation is caught upstream — not a leak.",
            },
          ],
        },
      },
      {
        findingId: "finding-import-churn",
        anchor: "rennet:hunk/import-order-3",
        summary: "Import reordering churn in one file, no behavioural change",
        severity: "low",
        agreement: { kind: "concur", agree: 2, total: 2 },
      },
    ],
  };
}

/**
 * The honestly-empty case: a review that RAN and flagged nothing. Distinct from a
 * failed runner — the lens says "ran clean", never a silent all-clear masking a
 * runner that never executed.
 */
export function emptyFlaggedReviewFixture(): FlaggedReview {
  return { status: "ok", findings: [] };
}

/**
 * The failed-runner case: the automated review did not complete. The lens must
 * render this LOUDLY apart from "nothing flagged"; conflating the two is the exact
 * lie the empty-vs-failed distinction refuses.
 */
export function failedFlaggedReviewFixture(): FlaggedReview {
  return { status: "failed", reason: "the review harness did not report a result" };
}
