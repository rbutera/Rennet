import type { Review } from "@rennet/protocol";
import { useCallback, useMemo } from "react";
import { useCommand, useMutation } from "../data";
import { useRennetStore } from "../store";
import { resolveEntryMode } from "./handoff-data";
import type { PostReceipt } from "./post-review-lane";
import type { DraftedPr, PrReceipt } from "./rounds-lanes";
import type { ProposedVerdict } from "./selectors";

// ─────────────────────────────────────────────────────────────────────────────
// The hand-off exits — the wiring that turns C08's lanes LIVE (C08 cluster 6, Objective
// clauses 6/10, Reconciliation 3). The lanes are fully live over the store WITHOUT this hook
// (every drop/edit/retire/restore/verdict change is already real); this is the last mile: the
// registered, bound `publish.*` commands the sign-click reaches. Unlike C5's gated board read,
// `publish.compose`/`publish.review`/`publish.submitPr` ARE registered and bound — the egress
// wires LIVE now (only B11's durable living draft + real span-rework stay gated to cluster 8).
//
//   • Post Review (teammate PR) — `publish.compose(mode:"review")` composes the daemon's
//     byte-exact outbound review; the sign-click mints a consent token bound to (review, target,
//     payload, verdict) and posts via `publish.review(dryRun:false)`, which re-derives the SAME
//     bytes before anything leaves. The preview equals what posts (R33). This mirrors the mobile
//     publish flow exactly (`apps/mobile/.../publish.tsx`) — the single-source egress the daemon
//     already answers, not a client-fabricated post.
//   • Open Pull Request (own branch) — `publish.compose(mode:"pr")` composes the submission the
//     lane previews AND the sign-click opens via `publish.submitPr` (no consent token: pushing your
//     own branch is not publishing, AGENTS.md). Composed once, submitted verbatim.
//
// Rennet never posts as itself: the review goes out under the user's name, and the click IS the
// post. No consent dialog, no freeze — the token is protocol-internal integrity, invisible here
// (Rule Zero). Absent a resolved egress, a CTA renders disabled (honest), never a Post that posts
// nothing.
// ─────────────────────────────────────────────────────────────────────────────

/** The live exits the route threads into `<HandoffView>` — the mode picks which are present. */
export interface HandoffExits {
  /** Post Review egress (teammate-PR mode). Absent for own-branch/retrospective reviews. */
  readonly onPost?: (args: { verdict: ProposedVerdict }) => Promise<PostReceipt>;
  /** Open-Pull-Request egress (own-branch mode). Absent until a PR is composed + ready. */
  readonly onOpenPr?: () => Promise<PrReceipt>;
  /** The composed own-branch PR the rounds lane renders. Absent ⇒ the page stays Changes. */
  readonly pr?: DraftedPr;
}

export function useHandoffExits(review: Review): HandoffExits {
  const mode = resolveEntryMode(review);
  const reviewId = review.id;
  const target = review.postTarget;

  // The egress writes (C01 §2.5): each a registered, bound publish command over the bridge. The
  // standing law routes every write through `useMutation` — no surface calls `bridge.invoke`.
  const { mutate: composeReview } = useMutation("publish.compose");
  const { mutate: requestConsent } = useMutation("publish.requestConsent");
  const { mutate: postReview } = useMutation("publish.review");
  const { mutate: submitPr } = useMutation("publish.submitPr");

  // Own-branch PR preview: `publish.compose(mode:"pr")` composes the daemon's byte-exact submission
  // (live, Reconciliation 3) — BOTH the draft the lane shows and the bytes the sign-click opens
  // (composed once, submitted verbatim). Enabled only once nothing is left to ask, so a still-
  // gathering review never raises a premature publish-ready. A retrospective/teammate review never
  // composes a PR (the command answers `unavailable`, but `enabled:false` skips the fetch entirely).
  const noAsks = useRennetStore((s) => Object.keys(s.review.stagedAsks).length === 0);
  // A component-stable correlation id: the useCommand cache key already carries `reviewId` + `mode`,
  // so a review switch refetches on its own; the id only needs to stay put across re-renders.
  const prCommandId = useMemo(() => crypto.randomUUID(), []);
  const prCompose = useCommand(
    "publish.compose",
    { commandId: prCommandId, reviewId, mode: "pr" },
    { enabled: mode === "own-branch" && noAsks },
  );
  const prComposed = prCompose.data?.status === "pr" ? prCompose.data : undefined;

  const onPost = useCallback(
    async ({ verdict }: { verdict: ProposedVerdict }): Promise<PostReceipt> => {
      // compose → the previewed bytes → requestConsent → review(dryRun:false): the real egress, on
      // the sign-click alone (task 6.1). The daemon composes the canonical outbound review; the
      // token binds (review, target, payload, verdict); publish.review re-derives the same bytes.
      const composed = await composeReview({
        commandId: crypto.randomUUID(),
        reviewId,
        mode: "review",
      });
      if (composed.status !== "review") {
        throw new Error(
          composed.status === "unavailable"
            ? composed.reason
            : "This review cannot be composed to post.",
        );
      }
      if (!target) throw new Error("This review has no pull request to post to.");
      const { authorization } = await requestConsent({
        commandId: crypto.randomUUID(),
        reviewId,
        target,
        payload: composed.payload,
        verdict,
        compositionId: composed.compositionId,
      });
      const result = await postReview({
        commandId: crypto.randomUUID(),
        reviewId,
        target,
        comments: composed.comments,
        payload: composed.payload,
        verdict,
        authorization,
        compositionId: composed.compositionId,
        dryRun: false,
      });
      if (!result.outcome) throw new Error("The review did not post — nothing left the machine.");
      const lineCommentCount = composed.comments.filter((c) => c.line !== undefined).length;
      return { verdict, lineCommentCount, url: result.outcome.url ?? composed.destination };
    },
    [composeReview, requestConsent, postReview, reviewId, target],
  );

  const onOpenPr = useCallback(async (): Promise<PrReceipt> => {
    // The composed submission the lane previewed is exactly what opens — submitPr round-trips the
    // payload byte-exact and refuses a stale/cross-review submission via the compositionId.
    if (!prComposed) throw new Error("The pull request is not ready to open.");
    const { url, number } = await submitPr({
      commandId: crypto.randomUUID(),
      reviewId,
      submission: prComposed.submission,
      payload: prComposed.payload,
      compositionId: prComposed.compositionId,
    });
    return { number, url };
  }, [submitPr, reviewId, prComposed]);

  return {
    onPost: mode === "teammate-pr" ? onPost : undefined,
    onOpenPr: prComposed ? onOpenPr : undefined,
    pr: prComposed
      ? { title: prComposed.submission.title, body: prComposed.submission.body, ready: true }
      : undefined,
  };
}
