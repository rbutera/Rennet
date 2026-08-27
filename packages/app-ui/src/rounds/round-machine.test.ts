import { describe, expect, it } from "vitest";
import {
  FIXTURE_ROUND_COMPLETE_TICK,
  FIXTURE_ROUND_TIMELINE,
  roundStateAtTick,
} from "../test/fixtures/rounds";
import {
  advance,
  canRevealNewBoards,
  initialRoundState,
  type RoundPhase,
  runNavigation,
  runProgressFraction,
} from "./round-machine";

// The pure run machine (C09 §1.1) — walked over the fixture timeline. No React, no
// timers: `advance` is the only motion, navigation is DERIVED from the state a
// transition produced (the autopsy S9 fence).

const SLUG = "s-1";

describe("round-machine — the pure run state machine", () => {
  it("walks absent → … → composed on the fixture timeline", () => {
    const walked = FIXTURE_ROUND_TIMELINE.reduce(advance, initialRoundState);
    expect(walked.phase).toBe("composed");
    if (walked.phase !== "composed") throw new Error("unreachable");
    // The terminal state carries the report board id and the new generation the reveal
    // navigates to — the only two things `composed` renders.
    expect(walked.reportBoardId).toBe("report-round-1");
    expect(walked.newGeneration).toBe("gen2");
  });

  it("advances through every phase in order over the timeline", () => {
    const seen = new Set<RoundPhase>();
    for (let n = 0; n <= FIXTURE_ROUND_COMPLETE_TICK; n++) seen.add(roundStateAtTick(n).phase);
    // absent through composed all appear as the clock is injected tick by tick.
    for (const phase of [
      "absent",
      "dispatching",
      "preparing",
      "working",
      "gating",
      "committing",
      "reporting",
      "composing",
      "composed",
    ] as const) {
      expect(seen.has(phase)).toBe(true);
    }
  });

  it("canRevealNewBoards is false until composed — the reveal gate, not a disabled button", () => {
    for (let n = 0; n < FIXTURE_ROUND_COMPLETE_TICK; n++) {
      expect(canRevealNewBoards(roundStateAtTick(n))).toBe(false);
    }
    expect(canRevealNewBoards(roundStateAtTick(FIXTURE_ROUND_COMPLETE_TICK))).toBe(true);
  });

  it("runNavigation stays null while the round is in flight, then hands off to the board surface", () => {
    // Watching phases keep the reviewer on the run route (no effect-driven redirect).
    for (const phase of ["dispatching", "preparing", "working", "gating", "committing"] as const) {
      const at = FIXTURE_ROUND_TIMELINE.findIndex(
        (_e, i) => roundStateAtTick(i + 1).phase === phase,
      );
      expect(runNavigation(roundStateAtTick(at + 1), SLUG)).toBeNull();
    }
    // Once the report has drafted (reporting) and once composed, navigation leaves the
    // run takeover for the board surface — derived from state, replacing history.
    for (const phase of ["reporting", "composing", "composed"] as const) {
      const at = FIXTURE_ROUND_TIMELINE.findIndex(
        (_e, i) => roundStateAtTick(i + 1).phase === phase,
      );
      const nav = runNavigation(roundStateAtTick(at + 1), SLUG);
      expect(nav).toEqual({ path: "/s/s-1", replace: true });
    }
  });

  it("a cold absent state derives a redirect to the session board (no double-dispatch, no effect race)", () => {
    expect(runNavigation(initialRoundState, SLUG)).toEqual({ path: "/s/s-1", replace: true });
  });

  it("runProgressFraction rises monotonically from 0 (absent) to 1 (composed)", () => {
    expect(runProgressFraction(initialRoundState)).toBe(0);
    let previous = -1;
    for (let n = 0; n <= FIXTURE_ROUND_COMPLETE_TICK; n++) {
      const fraction = runProgressFraction(roundStateAtTick(n));
      expect(fraction).toBeGreaterThanOrEqual(previous);
      previous = fraction;
    }
    expect(runProgressFraction(roundStateAtTick(FIXTURE_ROUND_COMPLETE_TICK))).toBe(1);
  });

  it("ignores out-of-order events (a trust boundary), never crashing forward", () => {
    // A `composed` event with no round in flight is ignored, not applied.
    expect(advance(initialRoundState, { type: "composed", generation: "gen2" })).toBe(
      initialRoundState,
    );
    // A `worker` event before dispatch is ignored.
    expect(advance(initialRoundState, { type: "worker", rows: [] })).toBe(initialRoundState);
  });

  it("a failure moves an in-flight round to failed, but never un-settles a composed one", () => {
    const dispatching = advance(initialRoundState, { type: "dispatched" });
    expect(advance(dispatching, { type: "failed", reason: "gate failed" })).toEqual({
      phase: "failed",
      reason: "gate failed",
    });
    const composed = FIXTURE_ROUND_TIMELINE.reduce(advance, initialRoundState);
    expect(advance(composed, { type: "failed", reason: "late" })).toBe(composed);
  });
});
