import type { CoachSnapshot } from "./store";

// ─────────────────────────────────────────────────────────────────────────────
// Coach persistence sequencing (C13 fix-loop, finding 2). The provider fires a
// persist on every dismiss / skip-all / replay. The naive `void mutate(snapshot)`
// discarded the promise: a rejecting bridge (malformed config, transport failure)
// became an unobserved rejection AND the failed write was forgotten, so a reload
// resurrected a dismissed mark or undid skip-all while the UI acted as saved.
//
// This wraps the write with observe + latest-wins, no ceremony (Rule Zero) — no
// dialog, no blocking UI, no "retrying…" banner. It just keeps trying to land the
// LATEST snapshot:
//
//   • SINGLE-FLIGHT. At most one write in flight, so two writes never complete out
//     of order and let a stale success clobber a newer state (the delayed-bridge
//     hazard). When a write settles, if the latest snapshot is newer than what last
//     landed, the next write fires with THAT — never the one already superseded.
//   • RETAIN + RE-FIRE. On failure the latest dirty snapshot is kept and retried
//     after a short delay, or sooner the instant a fresh change arrives.
//
// The store always allocates a fresh snapshot object per change, so reference
// identity is a sound "is this newer than what landed" test.
// ─────────────────────────────────────────────────────────────────────────────

/** Default gap before retrying a failed write. A fresh change fires sooner. */
const DEFAULT_RETRY_MS = 1000;

/**
 * Wrap an async persist call in latest-wins single-flight sequencing. Returns a
 * fire-and-forget `persist(snapshot)` the store can call on every change: it never
 * throws, never leaves an unobserved rejection, and converges on the newest snapshot.
 */
export function createLatestWinsPersist(
  send: (snapshot: CoachSnapshot) => Promise<unknown>,
  retryMs: number = DEFAULT_RETRY_MS,
): (snapshot: CoachSnapshot) => void {
  let latest: CoachSnapshot | null = null;
  let landed: CoachSnapshot | null = null;
  let inFlight = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const pump = () => {
    // Nothing to do if a write is already flying, a retry is armed, or the latest
    // snapshot already landed.
    if (inFlight || retryTimer || latest === null || latest === landed) return;
    const snapshot = latest;
    inFlight = true;
    void send(snapshot)
      .then(() => {
        landed = snapshot;
        inFlight = false;
        pump(); // a newer snapshot may have arrived mid-flight — chase it
      })
      .catch(() => {
        inFlight = false;
        // Retain the dirty snapshot; retry after a short delay (a fresh change fires sooner).
        retryTimer = setTimeout(() => {
          retryTimer = null;
          pump();
        }, retryMs);
      });
  };

  return (snapshot) => {
    latest = snapshot;
    // A fresh change supersedes any pending retry — try it now, not after the wait.
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    pump();
  };
}
