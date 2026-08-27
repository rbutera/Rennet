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

/** A live progress row's status — the spike's queued / spinner / check, as data. */
export type RowStatus = "queued" | "running" | "done" | "failed";

/** One streamed progress row (a prep step, a worker turn, a lens drafter). The route
 *  renders the rows the current phase carries; status is data, never a wall clock. */
export interface LaneRow {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly status: RowStatus;
}

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
      readonly lanes: readonly LaneRow[];
    }
  | { readonly phase: "composed"; readonly reportBoardId: string; readonly newGeneration: string }
  | { readonly phase: "failed"; readonly reason: string };

/** The phase discriminants, in progress order. */
export type RoundPhase = RoundState["phase"];

/** The honest-absent starting state — no round, nothing to render. */
export const initialRoundState: RoundState = { phase: "absent" };

/**
 * A folded progress event — one `onProgress` payload from the rounds runtime (B9) or a
 * fixture tick. Each event carries the current SNAPSHOT of its group's rows (not a
 * delta), so a stream that re-sends the same group's rows just updates them in place.
 */
export type RoundEvent =
  | { readonly type: "dispatched" }
  | { readonly type: "prep"; readonly rows: readonly LaneRow[] }
  | { readonly type: "worker"; readonly rows: readonly LaneRow[] }
  | { readonly type: "gate" }
  | { readonly type: "committed" }
  | { readonly type: "report"; readonly reportBoardId: string }
  | { readonly type: "lens"; readonly lanes: readonly LaneRow[] }
  | { readonly type: "composed"; readonly generation: string }
  | { readonly type: "failed"; readonly reason: string };

/**
 * The pure transition. Forward-only and tolerant: an event that does not apply to the
 * current phase returns the state unchanged (progress channels can duplicate or
 * re-order, and the machine is a trust boundary). A `failed` event from any IN-FLIGHT
 * phase moves to `failed`; from a terminal or absent state it is ignored, so a settled
 * round never un-settles.
 */
export function advance(state: RoundState, event: RoundEvent): RoundState {
  if (event.type === "failed") {
    return state.phase === "absent" || state.phase === "composed" || state.phase === "failed"
      ? state
      : { phase: "failed", reason: event.reason };
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
      if (event.type === "lens")
        return { phase: "composing", reportBoardId: state.reportBoardId, lanes: event.lanes };
      if (event.type === "composed")
        return {
          phase: "composed",
          reportBoardId: state.reportBoardId,
          newGeneration: event.generation,
        };
      return state;
    case "composed":
    case "failed":
      return state; // terminal
  }
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
