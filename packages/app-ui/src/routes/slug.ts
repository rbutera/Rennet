import type { Review, SidebarSession } from "@rennet/protocol";
import { readCommandId, useCommand } from "../data";

// ─────────────────────────────────────────────────────────────────────────────
// Slug resolution — what `/s/:slug` is looking at.
//
// The slug IS the durable session id (C21: `SessionModel.id`, which `sidebar-data.ts`
// already reports as `slug`, and which the sidebar, the archived view and the command
// menu all navigate to). A session may or may not have a review attached, and the two
// cases are DIFFERENT SURFACES, not a success and a failure:
//
//   • a session WITH a review → the review workspace (today's whole product);
//   • a session WITHOUT one → a real, honest chat-only session. A freshly minted
//     session has no review — nothing on the server attaches one yet — so this is
//     what the front door actually opens onto. Rendering it as "not found" would
//     make a click that genuinely worked look broken.
//
// `session.list` carries no `reviewId` (C21 declined to add a permanently-absent
// field, and this module does not need one): the review read itself answers the
// question. Both reads run unconditionally — hooks may not be conditional, and the
// pair settles into exactly one of the arms below.
//
// An unresolvable slug is still an honest not-found, and a genuine fault is still an
// honest error — neither is ever painted as an empty session.
// ─────────────────────────────────────────────────────────────────────────────

export type SlugResolution =
  | { readonly status: "pending" }
  | { readonly status: "review"; readonly reviewId: string; readonly review: Review }
  /** A real session with no review attached yet — the chat-only session. */
  | { readonly status: "session"; readonly sessionId: string; readonly session: SidebarSession }
  | { readonly status: "not-found"; readonly slug: string }
  | { readonly status: "error"; readonly slug: string; readonly error: unknown };

/** The daemon's typed missing-review signal: server dispatch throws exactly this for an
 *  unknown reviewId (packages/server dispatch.ts `requireReviewById`), and the WS bridge
 *  reconstructs it as `new Error(message)`. Matching this — and ONLY this — is what
 *  separates a slug that names no review from a disconnect / IPC fault / server
 *  exception, so those never masquerade as "no review here". */
const MISSING_REVIEW_MESSAGE = "Review not found";

function isMissingReview(error: unknown): boolean {
  return error instanceof Error && error.message === MISSING_REVIEW_MESSAGE;
}

export function useSlugResolution(slug: string): SlugResolution {
  // A commandId DERIVED from the slug, not a fresh uuid: every reader of this slug
  // (the route screen and the chat dock's own reviewId resolution) then shares ONE
  // cache key and ONE fetch, instead of racing two loads of the same review. It goes
  // through `readCommandId` because the wire requires a UUID — a readable `load-${slug}`
  // is rejected by the daemon, which turned every session route into "Couldn't open this
  // review" on the real app.
  // An empty slug means "not on a session route" — a caller may still have to run the
  // hooks (they cannot be conditional), so the reads are disabled rather than fired at
  // an id that cannot exist.
  const on = slug !== "";
  const review = useCommand(
    "review.load",
    { commandId: readCommandId(`review.load:${slug}`), reviewId: slug },
    { enabled: on },
  );
  const sessions = useCommand("session.list", {}, { enabled: on });
  if (!on) return { status: "not-found", slug };

  if (review.data) {
    return { status: "review", reviewId: review.data.review.id, review: review.data.review };
  }
  if (review.error) {
    // A real fault is reported as a fault — never softened into an empty session.
    if (!isMissingReview(review.error)) {
      return { status: "error", slug, error: review.error };
    }
    // No review by this id. If a SESSION owns it, this is the chat-only session.
    const session = sessions.data?.sessions.find((candidate) => candidate.id === slug);
    if (session) return { status: "session", sessionId: session.id, session };
    // The list itself FAILED. "I could not read the list" is not "the slug is in no
    // list" — reporting a disconnect or a server fault as not-found blames the reviewer's
    // url for the daemon's problem. Report the fault that actually happened.
    if (sessions.error) return { status: "error", slug, error: sessions.error };
    // NOT-FOUND IS A CLAIM ABOUT ABSENCE, so only a settled, current list may make it.
    // `!sessions.data` alone covers the first-ever load and nothing else — which is the
    // wrong half of the problem, because the front door arrives here with the sidebar's
    // list ALREADY loaded. The mint stales it and navigates in the same act, so the list
    // in hand is populated and one session out of date: `find` misses the session that was
    // just minted and the click that worked renders "Not found". Refetching (`fetching`)
    // and known-out-of-date (`stale`) are both "wait", and stale covers the render between
    // the invalidation landing and the refetch starting.
    if (!sessions.data || sessions.stale || sessions.fetching) return { status: "pending" };
    return { status: "not-found", slug };
  }
  return { status: "pending" };
}

/** The review id `/s/:slug` is looking at, or `undefined` off a review (a chat-only
 *  session, a pending resolve, or no session route at all). The one place a surface
 *  should ask "which review am I on?" — it never guesses that the slug is a review id,
 *  which on a review-less session would send reads to a review that does not exist. */
export function reviewIdOf(resolution: SlugResolution): string | undefined {
  return resolution.status === "review" ? resolution.reviewId : undefined;
}
