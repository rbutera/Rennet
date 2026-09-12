import { selectRoundRunning, useRennetStore } from "../store";
import { useReviewActivityState } from "./review-activity-state";

// ─────────────────────────────────────────────────────────────────────────────
// IS RENNET WORKING? — the one answer the frame's chrome asks.
//
// The sphere in the sidebar lockup and the orb in the collapsed corner slot are the
// SAME fact rendered in whichever place the corner slot currently lives, so they read
// it from here rather than each deriving their own. Two sources, because "working"
// genuinely has two of them and a chrome that knew only one would go still while the
// other ran:
//
//   1. `useReviewActivityState` — any session whose preparation is running, including
//      sessions the reviewer has navigated away from (that is the whole point of the
//      durable projection: the frame is not the board that started it).
//   2. `selectRoundRunning` — a live round's regeneration, which is a run-store fact
//      and never reaches the session projection.
//
// Nothing here is a timer, and nothing counts: it is a boolean about the app, derived
// on every render from state the daemon's reads already keep current.
// ─────────────────────────────────────────────────────────────────────────────

/** Whether ANY Rennet work is in flight anywhere in the app. */
export function useAppWorking(): boolean {
  const sessionRunning = useReviewActivityState((s) =>
    Object.values(s.bySession).some((state) => state.kind === "running"),
  );
  const roundRunning = useRennetStore(selectRoundRunning);
  return sessionRunning || roundRunning;
}
