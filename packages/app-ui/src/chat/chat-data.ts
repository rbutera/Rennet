import type { SidebarSession } from "@rennet/protocol";
import { useRoute } from "wouter";
import { useCommand } from "../data";
import { preparationPhase } from "../preparation/preparation-phase";
import { reviewIdOf, useSlugResolution } from "../routes/slug";
import { ROUTES } from "../routes/url";

// ─────────────────────────────────────────────────────────────────────────────
// What is left of the chat dock's data seam after the orchestrator chat was retired
// (t3-lens-threads 4.2). Rennet's own transcript, its `review.ask` send, the
// ask-stream fold and the reattach read are all gone — the conversation is
// the session's T3 thread, and T3's own view owns every row in it.
//
// Two things survive, both read by `t3-chat-dock.tsx`: which review the route names, and
// the header trail. No filesystem access; imports only `../data` and the route helpers.
// ─────────────────────────────────────────────────────────────────────────────

/** The dock header's session trail. Honest-minimal: with no served identity the header
 *  shows the title alone. */
export interface ChatTrail {
  readonly title: string;
  readonly projectName?: string;
  /** The workspace every turn of this session runs in (session-bound-workspace). */
  readonly workspace?: string;
  readonly target?: "your-branch" | "your-pr" | "teammate-pr";
  readonly targetState?: "needs-you" | "merged" | "reviewed";
}

/**
 * The review id the ROUTE names, or undefined off a session route.
 *
 * The dock is mounted once by the layout, outside the outlet, so it cannot be handed a
 * review as a prop; it has to ask where it is. `/s/:slug` and `/s/:slug/run` are the two
 * routes that name a session (the same pair the layout gates the dock's visibility on).
 * Off both, there is no review and the dock is honestly empty.
 *
 * `useSlugResolution` — not the raw slug — is what answers, because the slug is a SESSION
 * id and a session may have no review attached. Guessing `reviewId = slug` would point
 * every read at a review that does not exist on a chat-only session and turn silence into
 * a "Review not found" error. `reviewIdOf` returns a review id only when one really
 * resolved. The read is shared: `useSlugResolution` keys `review.load` on a slug-derived
 * commandId, so the route screen and this hook hit ONE cache entry, not two fetches.
 */
export function useRouteReviewId(): string | undefined {
  return reviewIdOf(useSlugResolution(useRouteSlug()));
}

function useRouteSlug(): string {
  const [onSession, sessionParams] = useRoute(ROUTES.session);
  const [, runParams] = useRoute(ROUTES.sessionRun);
  const raw = (onSession ? sessionParams?.slug : runParams?.slug) ?? "";
  return raw === "" ? "" : decodeURIComponent(raw);
}

/**
 * WHAT THE DOCK IS LOOKING AT — three answers, because two of them are not "a review"
 * and the dock had been treating both as one (#872).
 *
 * `useRouteReviewId` collapses everything that is not a review into `undefined`, and the
 * dock turned that single silence into "Starting the T3 Code sidecar…" — the `pending ||
 * !data` arm of a read that is DISABLED off a review and therefore never resolves. On a
 * chat-only session (a New Chat mint before its capture attaches, or a session that never
 * gets one) the reviewer watched the app report a bring-up that was not happening and
 * never would.
 *
 * So the two are separated. `resolving` is a real wait on `session.list` + `review.load`;
 * `no-review` is settled for as long as the route stays there. Neither of them starts a
 * sidecar, because there is nothing to start one for.
 */
export type ChatDockTarget =
  | { readonly kind: "resolving" }
  | { readonly kind: "review"; readonly reviewId: string }
  /**
   * No review is attached. `preparing` says one is on its way — capture is running, the
   * large-file question is open, or drafting has begun before the thread exists — so the
   * dock shows the thread's skeleton (review-preparation-reliability D6). Otherwise the
   * dock shows nothing: a stopped preparation's failure block owns the message, and a
   * session that was never prepared has no thread to describe.
   */
  | { readonly kind: "no-review"; readonly preparing: boolean };

export function useRouteChatTarget(): ChatDockTarget {
  const slug = useRouteSlug();
  const resolution = useSlugResolution(slug);
  const row = useSessionRow(slug);
  if (resolution.status === "pending") return { kind: "resolving" };
  const reviewId = reviewIdOf(resolution);
  if (reviewId !== undefined) return { kind: "review", reviewId };
  const phase = preparationPhase(row?.preparation);
  return {
    kind: "no-review",
    preparing: phase === "waiting" || phase === "choosing" || phase === "drafting",
  };
}

/** The route's session row, off the one shared `session.list` read. */
function useSessionRow(slug: string): SidebarSession | undefined {
  const { data } = useCommand("session.list", {}, { enabled: slug !== "" });
  return data?.sessions.find((candidate) => candidate.id === slug);
}

/**
 * The header trail for a review, off the daemon's identity read. The trail transfers from
 * the top bar to the dock when the dock opens (C20 state 2), so the dock has to be able to
 * render it without the transcript that used to carry it. `session.transcript` is that
 * read; its `rows` are the coding turns, which the T3 view no longer renders here.
 *
 * Until that read answers — and for the whole of a preparation, when there is no review to
 * ask about — the trail is the SESSION's own title: the branch or pull request the reviewer
 * opened, off the same `session.list` row the sidebar shows. It used to fall back to the
 * literal "New review", which put a placeholder where the reviewer's own branch belonged
 * (review-preparation-reliability: "'New review' … that's really bad UX").
 */
export function useChatTrail(reviewId: string | undefined): ChatTrail {
  const row = useSessionRow(useRouteSlug());
  const { data } = useCommand(
    "session.transcript",
    { reviewId: reviewId ?? "" },
    { enabled: reviewId !== undefined },
  );
  return data?.trail ?? { title: row?.title ?? "" };
}
