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
//   • a session WITHOUT one and WITHOUT preparation → a real, honest chat-only session.
//     New Chat sessions carry a durable preparation state until their review is ready;
//     older or intentionally bare sessions can still have neither.
//
// WHICH review a session holds is the session's own fact (#587): New Chat's row click
// captures the clicked branch/PR in the background and attaches the review to the minted session, so
// `session.list` carries `reviewId`. The list is therefore read FIRST and the review
// read waits for it — guessing that the slug is a review id before the list settles
// would flash the chat-only surface over a session that does have a review.
//
// The slug itself remains the fallback review id, so the `/s/<reviewId>` links that
// predate durable sessions still resolve.
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
  const sessions = useCommand("session.list", {}, { enabled: on });
  const session = sessions.data?.sessions.find((candidate) => candidate.id === slug);
  // The review this slug is looking at: the session's attached one (#587), else the slug
  // itself (a pre-session `/s/<reviewId>` link). Held until the list is CURRENT — a stale
  // or in-flight list would answer "no review" for a session that has one.
  const listCurrent = sessions.data !== undefined && !sessions.stale && !sessions.fetching;
  const reviewId = session?.reviewId ?? slug;
  const review = useCommand(
    "review.load",
    { commandId: readCommandId(`review.load:${reviewId}`), reviewId },
    { enabled: on && (listCurrent || sessions.error !== undefined) },
  );
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

/**
 * The PROJECT `/s/:slug` belongs to — read off the session row that names it, which is the
 * only thing that can answer it. `review.repositoryRoot` cannot: a workspace project holds
 * several repositories, so a root does not name a project back (AGENTS.md, "a workspace maps
 * MANY repos to ONE identity").
 *
 * Three answers, not two. `undefined` ⇒ still reading, so nothing is claimed either way;
 * `null` ⇒ the read SETTLED and no project came back — either the list names no row for this
 * slug (a legacy `/s/<reviewId>` link) or the list could not be read at all. A surface that
 * collapses `undefined` into `null` narrates a still-loading list as an absence.
 *
 * A failed read lands in `null` deliberately: the caller's job is to say "no project to work
 * from", which is true either way, and inventing a project from the review would be the
 * repo→project guess this comment starts by ruling out.
 *
 * Shares the `session.list` read `useSlugResolution` already runs — same cache key, one fetch.
 */
export function useSessionProjectId(slug: string): string | null | undefined {
  const { data, pending } = useCommand("session.list", {}, { enabled: slug !== "" });
  if (pending) return undefined;
  return data?.sessions.find((session) => session.id === slug)?.projectId ?? null;
}

/** The review id `/s/:slug` is looking at, or `undefined` off a review (a chat-only
 *  session, a pending resolve, or no session route at all). The one place a surface
 *  should ask "which review am I on?" — it never guesses that the slug is a review id,
 *  which on a review-less session would send reads to a review that does not exist. */
export function reviewIdOf(resolution: SlugResolution): string | undefined {
  return resolution.status === "review" ? resolution.reviewId : undefined;
}
