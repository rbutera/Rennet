import type { Review } from "@rennet/protocol";
import { useCallback, useMemo } from "react";
import { useCommand, useMutation } from "../data";
import { useRennetStore } from "../store";
import {
  composeReviewDraft,
  type ReviewDraft,
  type ReviseSpan,
  resolveEntryMode,
} from "./handoff-data";
import type { PostReceipt } from "./post-review-lane";
import type { DraftedPr, PrReceipt } from "./rounds-lanes";
import type { ProposedVerdict } from "./selectors";

// ─────────────────────────────────────────────────────────────────────────────
// The hand-off exits — the wiring that turns C08's lanes LIVE (C08 cluster 6, Objective
// clauses 6/10, Reconciliation 3). The lanes are fully live over the store WITHOUT this hook
// (every drop/edit/retire/restore/verdict change is already real); this is the last mile: the
// registered, bound `publish.*` commands the sign-click reaches. Unlike C5's gated board read,
// `publish.compose`/`publish.review`/`publish.submitPr` ARE registered and bound — the egress
// wires LIVE now, and so does `review.reviseSpan` (B11 landed; only the durable living-draft
// SOURCE still composes off the store).
//
//   • Post Review (teammate PR) — `publish.compose(mode:"review")` composes the daemon's
//     byte-exact outbound review; the click posts it via `publish.review(dryRun:false)`, which
//     re-derives the SAME bytes and re-checks the composition binding (payload AND verdict)
//     before anything leaves. The preview equals what posts (R33). This mirrors the mobile
//     publish flow exactly (`apps/mobile/.../publish.tsx`) — the single-source egress the daemon
//     already answers, not a client-fabricated post.
//   • Open Pull Request (own branch) — `publish.compose(mode:"pr")` composes the submission the
//     lane previews AND the click opens via `publish.submitPr` (pushing your own branch is not
//     publishing, AGENTS.md). Composed once, submitted verbatim.
//
// Rennet never posts as itself: the review goes out under the user's name, and the click IS the
// post — there is no token, no consent dialog and no freeze (Rule Zero, #435). The verdict is not
// a separate post argument either: flipping it writes the durable override and RECOMPOSES, so the
// event that posts is the event on screen. Absent a resolved egress, a CTA renders disabled
// (honest), never a Post that posts nothing — and when the daemon REFUSED to compose, its reason
// travels out as `unavailable` and the lane states it. A disabled CTA with the refusal on the
// floor was the only thing here that read as a gate; it was silence, not ceremony.
// ─────────────────────────────────────────────────────────────────────────────

/** The live exits the route threads into `<HandoffView>` — the mode picks which are present. */
export interface HandoffExits {
  /** Post Review egress (teammate-PR mode). Absent until the review is composed (or off-mode). */
  readonly onPost?: () => Promise<PostReceipt>;
  /**
   * Flip the review verdict. A WRITE against the durable ask log (`ask.setVerdictOverride`), so
   * the daemon recomposes and the composed verdict becomes the flipped one — the single channel.
   * `null` clears the override back to the derived proposal.
   */
  readonly onSetVerdict: (verdict: ProposedVerdict | null) => void;
  /**
   * The composed outbound review the Post Review lane PREVIEWS — byte-exact with what `onPost`
   * posts (the exact-preview contract). Absent while composing / when the daemon can't compose.
   */
  readonly reviewDraft?: ReviewDraft;
  /** Open-Pull-Request egress (own-branch mode). Absent until a PR is composed + ready. */
  readonly onOpenPr?: () => Promise<PrReceipt>;
  /** The composed own-branch PR the rounds lane renders. Absent ⇒ the page stays Changes. */
  readonly pr?: DraftedPr;
  /**
   * Selection-steer Revise, bound to B11's `review.reviseSpan` (cluster 8). Always present here —
   * the command is registered and host-bound for every mode; a lane mounted WITHOUT it (unit
   * mounts) says so rather than pretending.
   */
  readonly onRevise: ReviseSpan;
  /**
   * Why the daemon could not compose this mode's exit, in its OWN words — or `undefined` when it
   * composed fine. `publish.compose` answers `unavailable` with a reason for every refusal it
   * knows (an unsafe comment path, a detached HEAD, a mode that does not fit the review), and
   * every one of those refusals lands the lane in a state with no live exit: the Post CTA renders
   * disabled, or the rounds lane never becomes the pull request. Dropping the reason left a dead
   * grey button and no account of it — and `HandoffAction` can only surface an error a CLICK
   * threw, which a disabled button forbids.
   *
   * This is a STATEMENT, not a gate — the same shape as `RoundsSource.roundsUnavailable`: the
   * lane renders the reason where the exit would have been and carries on. Nothing to dismiss.
   */
  readonly unavailable?: string;
}

export function useHandoffExits(review: Review): HandoffExits {
  const mode = resolveEntryMode(review);
  const reviewId = review.id;
  const target = review.postTarget;

  // The egress writes (C01 §2.5): each a registered, bound publish command over the bridge. The
  // standing law routes every write through `useMutation` — no surface calls `bridge.invoke`.
  const { mutate: postReview } = useMutation("publish.review");
  const { mutate: submitPr } = useMutation("publish.submitPr");
  // The verdict flip (#435): a WRITE against the durable ask log, so it stales the composed
  // preview — invalidate `publish.compose` and the lane recomposes with the flipped verdict.
  // This is the ONLY verdict channel: `onPost` posts the composed verdict, and the daemon's
  // composition binding refuses any other, so a flip that did not recompose cannot post.
  const { mutate: setVerdictOverride } = useMutation("ask.setVerdictOverride", {
    invalidates: ["publish.compose"],
  });
  // Span rework (B11 cluster 5): a WRITE against the durable ask log, so it stales any composed
  // preview — invalidate `publish.compose` and the lane recomposes off the reworked ask.
  const { mutate: reviseSpan } = useMutation("review.reviseSpan", {
    invalidates: ["publish.compose"],
  });

  // Teammate-PR review preview: compose ONCE, on open (the exact-preview contract — R33,
  // architecture-contracts.md "Posting to GitHub"). The lane PREVIEWS these composed bytes and
  // the sign-click posts the SAME composition (`onPost` below never re-composes) — so the review
  // the reviewer signs IS the review that leaves. A stable command id keeps the read from
  // refetching across re-renders (the cache key already carries `reviewId` + `mode`).
  const reviewCommandId = useMemo(() => crypto.randomUUID(), []);
  const reviewCompose = useCommand(
    "publish.compose",
    { commandId: reviewCommandId, reviewId, mode: "review" },
    { enabled: mode === "teammate-pr" },
  );
  const reviewComposed = reviewCompose.data?.status === "review" ? reviewCompose.data : undefined;

  // Own-branch PR preview: `publish.compose(mode:"pr")` composes the daemon's byte-exact submission
  // (live, Reconciliation 3) — BOTH the draft the lane shows and the bytes the sign-click opens
  // (composed once, submitted verbatim). Enabled only once nothing is left to ask, so a still-
  // gathering review never raises a premature publish-ready. A retrospective/teammate review never
  // composes a PR (the command answers `unavailable`, but `enabled:false` skips the fetch entirely).
  //
  // And NOT for your own already-open PR. `resolveEntryMode` routes that here (C14 §6: it is still
  // your branch, rounds keep going, and the round loop IS the exit), but there is no PR left to
  // open, so the daemon refuses with `"This is a team-PR review…"`. That refusal is wrong twice
  // over on this path — the reviewer authored the PR, and nothing is broken — and now that a
  // refusal RENDERS, asking would narrate a correct session as a fault, in the daemon's internal
  // mode vocabulary. So do not ask a question whose answer is already known. The Changes surface
  // with a live Dispatch Round is what states this mode; it needs no caption.
  const noAsks = useRennetStore((s) => Object.keys(s.review.stagedAsks).length === 0);
  // A component-stable correlation id: the useCommand cache key already carries `reviewId` + `mode`,
  // so a review switch refetches on its own; the id only needs to stay put across re-renders.
  const prCommandId = useMemo(() => crypto.randomUUID(), []);
  const prCompose = useCommand(
    "publish.compose",
    { commandId: prCommandId, reviewId, mode: "pr" },
    { enabled: mode === "own-branch" && noAsks && target === undefined },
  );
  const prComposed = prCompose.data?.status === "pr" ? prCompose.data : undefined;

  // The refusal for whichever compose this mode actually ran. Only one is ever `enabled`, so
  // there is no ambiguity about whose words these are.
  const compose = mode === "own-branch" ? prCompose : reviewCompose;
  const unavailable = compose.data?.status === "unavailable" ? compose.data.reason : undefined;

  const onPost = useCallback(async (): Promise<PostReceipt> => {
    // Post the ALREADY-composed bytes the lane previewed — never a fresh compose (that recompose
    // was the exact-preview break: the reviewer signs a preview, a re-derivation posts). The
    // previewed `reviewComposed` IS the payload AND the verdict: publish.review round-trips the
    // bytes and re-checks the compositionId, which binds both, so a stale/cross-review post or a
    // verdict other than the previewed one is refused. Real egress on the click alone.
    if (!reviewComposed) throw new Error("The review is not composed yet.");
    if (!target) throw new Error("This review has no pull request to post to.");
    const verdict = reviewComposed.verdict;
    const result = await postReview({
      commandId: crypto.randomUUID(),
      reviewId,
      target,
      comments: reviewComposed.comments,
      bodyNotes: reviewComposed.bodyNotes ?? [],
      payload: reviewComposed.payload,
      verdict,
      compositionId: reviewComposed.compositionId,
      dryRun: false,
    });
    if (!result.outcome) throw new Error("The review did not post — nothing left the machine.");
    const lineCommentCount = reviewComposed.comments.filter((c) => c.line !== undefined).length;
    return { verdict, lineCommentCount, url: result.outcome.url ?? reviewComposed.destination };
  }, [postReview, reviewId, target, reviewComposed]);

  const onSetVerdict = useCallback(
    (verdict: ProposedVerdict | null) => {
      void setVerdictOverride({ sessionId: reviewId, verdict });
    },
    [setVerdictOverride, reviewId],
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

  // The rework the selection toolbar reaches through the `handoff-data.ts` seam. It stages a
  // revised ask and posts NOTHING (push ≠ publish) — so it needs no consent token and no mode
  // condition; a failed/no-change rework comes back as an honest status the panel states.
  const onRevise = useCallback<ReviseSpan>(
    ({ askId, span, instruction }) =>
      reviseSpan({ commandId: crypto.randomUUID(), reviewId, askId, span, instruction }),
    [reviseSpan, reviewId],
  );

  return {
    // Post is armed only once the review is composed — so the previewed bytes and the posted bytes
    // are one composition (the CTA renders disabled until then, honest).
    onPost: mode === "teammate-pr" && reviewComposed ? onPost : undefined,
    onSetVerdict,
    reviewDraft: reviewComposed ? composeReviewDraft(reviewComposed) : undefined,
    onOpenPr: prComposed ? onOpenPr : undefined,
    pr: prComposed
      ? { title: prComposed.submission.title, body: prComposed.submission.body, ready: true }
      : undefined,
    onRevise,
    ...(unavailable === undefined ? {} : { unavailable }),
  };
}
