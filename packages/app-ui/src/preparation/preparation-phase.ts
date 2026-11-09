import type { SessionPreparation } from "@rennet/protocol";
import { useCommand } from "../data";

// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE PREPARATION SURFACE SHOWS (review-preparation-reliability D6), read once off the
// session's own preparation record so the rail, the board, the chat dock and the header
// can never disagree about it.
//
//   waiting    capture is running, or drafting has begun and no lane has left `queued`.
//              Nothing names a seat yet, so the surface shows ONE waiting presence: the
//              rail breathing and the board as a skeleton. It never says which step.
//   choosing   preparation stopped for the large-file question. The presence keeps going
//              behind the question, because the review is still on its way.
//   drafting   at least one lane has moved. The seats speak for themselves from here
//              (lens-seats.ts): the rail's per-seat marks and the board's own in-progress
//              signals, so the presence steps aside.
//   failed / cancelled   the run is over. One block says what happened and what to do.
//
// `undefined` means no preparation is on record: a settled review, or a session that was
// never prepared. Nothing about preparation renders then.
// ─────────────────────────────────────────────────────────────────────────────

export type PreparationPhase = "waiting" | "choosing" | "drafting" | "failed" | "cancelled";

export function preparationPhase(
  preparation: SessionPreparation | undefined,
): PreparationPhase | undefined {
  switch (preparation?.status) {
    case undefined:
      return undefined;
    case "capturing":
      return "waiting";
    case "awaiting":
      return "choosing";
    case "drafting":
      // Every lane still `queued` is the moment between the workspace being bound and the
      // lenses kicking off: no seat exists, so it is the same wait capture was.
      return preparation.lanes.every((lane) => lane.status === "queued") ? "waiting" : "drafting";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      // A status a newer daemon adds is read as the wait, never as a failure it did not say.
      return "waiting";
  }
}

/** Whether the waiting presence (rail breath + board skeleton) is what the surface shows. */
export function presenceShows(phase: PreparationPhase | undefined): boolean {
  return phase === "waiting" || phase === "choosing";
}

/** Whether the run is over without a settled review: the failure block's phases. */
export function preparationStopped(phase: PreparationPhase | undefined): boolean {
  return phase === "failed" || phase === "cancelled";
}

/** The session row the route is on, off the one shared `session.list` read. */
export function useSessionPreparation(slug: string): SessionPreparation | undefined {
  const { data } = useCommand("session.list", {}, { enabled: slug.length > 0 });
  return data?.sessions.find((candidate) => candidate.id === slug)?.preparation;
}

/** The phase the route's session is in. Shares `session.list`'s cache key with every other
 *  reader, so the header's poll moves this too. */
export function usePreparationPhase(slug: string): PreparationPhase | undefined {
  return preparationPhase(useSessionPreparation(slug));
}
