import type { RoundEvent } from "@rennet/protocol";

// ─────────────────────────────────────────────────────────────────────────────
// The live round-progress hub (C15 3.1) — the server half of the channel that replaces
// the client's fixture timeline with a real feed.
//
// It is an APPEND-ONLY EVENT LOG per review, not a state machine. The machine lives on
// the client (`app-ui/src/rounds/round-machine.ts`), and it is a pure fold; keeping the
// server as the log means the two ends cannot disagree about a phase, and a client that
// joins late (a cold `/s/:slug/run` deep-link, or a reconnect mid-round) catches up by
// folding the same events the live subscriber folded — one reducer, one truth.
//
// Keyed by REVIEW id, because a slug IS a review id (`routes/slug.ts`): the run route
// subscribes with the id it already holds, and no session-id translation sits between the
// reviewer's URL and their round.
// ─────────────────────────────────────────────────────────────────────────────

/** How many events one review's round log retains. A round emits on the order of a
 *  dozen events; the cap only stops a pathological emitter growing without bound, and
 *  it drops the OLDEST first so the current phase always survives. */
const MAX_EVENTS_PER_REVIEW = 200;

export class RoundProgressHub {
  readonly #logs = new Map<string, RoundEvent[]>();
  readonly #broadcast: ((reviewId: string, event: RoundEvent) => void) | undefined;

  /** @param broadcast the live push sink (the WS listener's fan-out). Absent ⇒ the hub
   *  still records, so the `session.roundEvents` read is answerable with no live socket. */
  constructor(broadcast?: (reviewId: string, event: RoundEvent) => void) {
    this.#broadcast = broadcast;
  }

  /**
   * Record one real progress event and push it live. A `dispatched` event STARTS a round,
   * so it clears the prior round's log — the run route folds one round at a time, and a
   * second dispatch must not replay the first round's composed state.
   */
  emit(reviewId: string, event: RoundEvent): void {
    const log = event.type === "dispatched" ? [] : (this.#logs.get(reviewId) ?? []);
    log.push(event);
    if (log.length > MAX_EVENTS_PER_REVIEW) log.splice(0, log.length - MAX_EVENTS_PER_REVIEW);
    this.#logs.set(reviewId, log);
    this.#broadcast?.(reviewId, event);
  }

  /** The review's round events so far, oldest→newest. Empty when no round has dispatched
   *  — the honest absence the run machine starts from. */
  read(reviewId: string): readonly RoundEvent[] {
    return this.#logs.get(reviewId) ?? [];
  }

  /** A sink bound to one review — what a round's `onProgress` is handed. */
  sinkFor(reviewId: string): (event: RoundEvent) => void {
    return (event) => this.emit(reviewId, event);
  }
}
