import type { LaneRow, LensLane, RoundEvent } from "@rennet/protocol";
import { type Navigation, sessionPath } from "../routes/url";

// ─────────────────────────────────────────────────────────────────────────────
// The round run state machine (C09 §1, autopsy S9 fence). A PURE, transition-driven
// model of one work-order round from dispatch to a composed new generation. No React,
// no timers, no bridge: `advance(state, event)` is the only motion, and navigation is
// DERIVED from the state a transition produced ({@link runNavigation}), never computed
// in an effect that reads the state its own `navigate` mutates.
//
// The spike drove the whole loop off a `setInterval` clock (`run-view.tsx` counted to
// 10 100ms and fired `onReady`; `app/s/[slug]/run/page.tsx` then navigated from an
// effect and needed an `alreadyRanAtMount` ref to stop its own `router.replace` racing
// a `router.push`). That race is autopsy S9. Here the run is a machine: a folded
// `onProgress` payload (or a fixture tick) is a {@link RoundEvent}, the reducer walks
// the phases, and the route reads {@link runNavigation} off the resulting state. There
// is no effect that both mutates and reads the navigation target, so there is no race
// to guard.
// ─────────────────────────────────────────────────────────────────────────────

// The row/event vocabulary is the PROTOCOL's (C15 3.1): the daemon emits these events as a
// round really runs and this reducer folds them, so one definition serves both ends and the
// wire cannot drift from the machine. Re-exported here because every rounds surface reads
// them through the machine.
export type { LaneRow, LaneVerdict, LensLane, RoundEvent, RowStatus } from "@rennet/protocol";

/**
 * The run machine's state — a discriminated union carrying ONLY what each phase
 * renders. `absent` is the honest default (no live round). The middle phases carry the
 * accumulated prep/worker rows; `reporting` onward carries the report board id; and
 * `composed` carries the new generation id the reveal navigates to. `failed` is
 * terminal and carries its reason. There is no stored progress fraction or navigation
 * target — both are DERIVED ({@link runProgressFraction}, {@link runNavigation}).
 */
export type RoundState =
  | { readonly phase: "absent" }
  | { readonly phase: "dispatching" }
  | { readonly phase: "preparing"; readonly prep: readonly LaneRow[] }
  | {
      readonly phase: "working";
      readonly prep: readonly LaneRow[];
      readonly worker: readonly LaneRow[];
    }
  | {
      readonly phase: "gating";
      readonly prep: readonly LaneRow[];
      readonly worker: readonly LaneRow[];
    }
  | {
      readonly phase: "committing";
      readonly prep: readonly LaneRow[];
      readonly worker: readonly LaneRow[];
    }
  | { readonly phase: "reporting"; readonly reportBoardId: string }
  | {
      readonly phase: "composing";
      readonly reportBoardId: string;
      readonly lanes: readonly LensLane[];
    }
  | {
      readonly phase: "composed";
      /** The round's report board, when it drafted one. **Optional, and it matters:** a
       *  round with no successor account is not a round to the pipeline, so its report
       *  seat never runs and no report board exists — the commonest cause being that the
       *  coding agent ran and changed nothing. Such a round still regenerates and still
       *  composes; it simply has no greeting to hand back. */
      readonly reportBoardId?: string;
      readonly newGeneration: string;
      /** The lanes that were still on screen when the generation composed — carried
       *  through so the settled regeneration block does not blink out at the moment it
       *  finishes (C15 4.1/4.2: the kicker flips to "Regenerated the Boards" OVER the
       *  same rows). Optional: a `composed` reached without a preceding `lens` event
       *  (a round that composed nothing per-lens) honestly carries no lanes. */
      readonly lanes?: readonly LensLane[];
    }
  | { readonly phase: "failed"; readonly reason: string };

/** The phase discriminants, in progress order. */
export type RoundPhase = RoundState["phase"];

/** The honest-absent starting state — no round, nothing to render. */
export const initialRoundState: RoundState = { phase: "absent" };

/**
 * The pure transition. Forward-only and tolerant: an event that does not apply to the
 * current phase returns the state unchanged (progress channels can duplicate or
 * re-order, and the machine is a trust boundary). The two TERMINAL events — `failed` and
 * `composed` — apply from ANY in-flight phase, so a round that ends is always able to say
 * so; from a terminal or absent state both are ignored, so a settled round never
 * un-settles.
 */
export function advance(state: RoundState, event: RoundEvent): RoundState {
  if (event.type === "failed") {
    return state.phase === "absent" || state.phase === "composed" || state.phase === "failed"
      ? state
      : { phase: "failed", reason: event.reason };
  }
  // `composed` is terminal from ANY in-flight phase, for the same reason `failed` is: it
  // is the round's own account of having finished, and a machine that can only accept it
  // from one predecessor phase turns a missing intermediate event into a permanent stall.
  // The intermediate that goes missing in practice is `report` — a round with no successor
  // account never runs the report seat — and the run view then sat at `committing`
  // forever, ignoring the lens events and the composed generation behind it, showing a
  // live-looking round that had already ended.
  if (event.type === "composed") {
    if (state.phase === "absent" || state.phase === "composed" || state.phase === "failed") {
      return state;
    }
    const reportBoardId = "reportBoardId" in state ? state.reportBoardId : undefined;
    const lanes = state.phase === "composing" ? state.lanes : undefined;
    return {
      phase: "composed",
      newGeneration: event.generation,
      ...(reportBoardId === undefined ? {} : { reportBoardId }),
      ...(lanes === undefined ? {} : { lanes }),
    };
  }
  switch (state.phase) {
    case "absent":
      return event.type === "dispatched" ? { phase: "dispatching" } : state;
    case "dispatching":
      return event.type === "prep" ? { phase: "preparing", prep: event.rows } : state;
    case "preparing":
      if (event.type === "prep") return { phase: "preparing", prep: event.rows };
      if (event.type === "worker")
        return { phase: "working", prep: state.prep, worker: event.rows };
      return state;
    case "working":
      if (event.type === "worker")
        return { phase: "working", prep: state.prep, worker: event.rows };
      if (event.type === "gate") return { phase: "gating", prep: state.prep, worker: state.worker };
      return state;
    case "gating":
      return event.type === "committed"
        ? { phase: "committing", prep: state.prep, worker: state.worker }
        : state;
    case "committing":
      return event.type === "report"
        ? { phase: "reporting", reportBoardId: event.reportBoardId }
        : state;
    case "reporting":
      return event.type === "lens"
        ? { phase: "composing", reportBoardId: state.reportBoardId, lanes: event.lanes }
        : state;
    case "composing":
      return event.type === "lens"
        ? { phase: "composing", reportBoardId: state.reportBoardId, lanes: event.lanes }
        : state;
    case "composed":
    case "failed":
      return state; // terminal
  }
}

/**
 * Merge a catch-up read's events with the ones the live channel pushed, by the monotonic
 * `seq` the emitting hub stamps on each (review finding 7).
 *
 * Two writers feed one log and neither is authoritative alone: the read answers with the
 * daemon's log as of the moment it was served, and the push carries whatever happened
 * since — so installing the read's answer over the folded stream DROPS every event that
 * landed during the flight, and a dropped terminal event leaves the surface reading
 * "still working" over a round that finished. Merging by `seq` makes the two orders one:
 * an event already held is recognised and ignored, and the result is the union in the
 * order the daemon emitted it, never the order the transports happened to deliver it.
 *
 * A `dispatched` STARTS a round (the daemon's hub clears its log on one), so everything
 * before the NEWEST `dispatched` belongs to a round that is over and is dropped. That is
 * what stops a late terminal event from the previous round settling the round now running,
 * and it holds with or without a `seq` — it is a rule about the log, not about the ordering.
 *
 * Events with no `seq` come from a daemon that predates it — they cannot be ordered, so
 * they are kept in arrival order and never deduped. The honest degrade, not a handshake.
 */
export function mergeRoundEvents(
  read: readonly RoundEvent[],
  streamed: readonly RoundEvent[],
): readonly RoundEvent[] {
  if (streamed.length === 0) return [...read];
  const bySeq = new Map<number, RoundEvent>();
  const unsequenced: RoundEvent[] = [];
  for (const event of [...read, ...streamed]) {
    if (event.seq === undefined) unsequenced.push(event);
    else if (!bySeq.has(event.seq)) bySeq.set(event.seq, event);
  }
  const ordered = [...bySeq.keys()].sort((a, b) => a - b).map((s) => bySeq.get(s) as RoundEvent);
  const merged = [...unsequenced, ...ordered];
  const start = merged.findLastIndex((event) => event.type === "dispatched");
  return start > 0 ? merged.slice(start) : merged;
}

// ── Derived reads (the route/greeting read these; they never live in an effect) ──

/**
 * True ONLY at `composed` — the single gate for **View the New Boards** (C09 §5). The
 * control is rendered iff this is true; it is never a disabled button waiting to enable
 * (packet + INVENTORY §7.2), because "can reveal" is derived from the machine reaching
 * composition, not from an effect flipping a flag.
 */
export const canRevealNewBoards = (state: RoundState): boolean => state.phase === "composed";

const PHASE_ORDER: readonly RoundPhase[] = [
  "absent",
  "dispatching",
  "preparing",
  "working",
  "gating",
  "committing",
  "reporting",
  "composing",
  "composed",
];

/** A coarse 0..1 progress fraction, DERIVED from the phase's position in the run — not
 *  a stored count. `failed` reads as complete (the run stopped). */
export function runProgressFraction(state: RoundState): number {
  if (state.phase === "failed") return 1;
  return PHASE_ORDER.indexOf(state.phase) / (PHASE_ORDER.length - 1);
}

/**
 * The navigation a transition implies — the S9 fence's replacement for effect-driven
 * routing. The run route READS this off the current state and navigates when it is
 * non-null; it never computes a target inside an effect that reads the state its own
 * navigate changes.
 *
 * - `absent` (a cold `/s/:slug/run` deep-link with no live round) ⇒ redirect to the
 *   session board (replace — the run route leaves no back-stack entry).
 * - `reporting` / `composing` / `composed` ⇒ leave the run takeover for the board
 *   surface, where the report is the greeting and regeneration streams beneath.
 * - every in-flight phase (`dispatching`…`committing`) and `failed` ⇒ `null`: stay on
 *   the run route (failed renders its reason there).
 */
export function runNavigation(state: RoundState, slug: string): Navigation | null {
  switch (state.phase) {
    case "absent":
    case "reporting":
    case "composing":
    case "composed":
      return { path: sessionPath(slug, { view: "board" }), replace: true };
    default:
      return null;
  }
}
