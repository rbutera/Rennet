import type { RoundOperationProgressSnapshot } from "@rennet/protocol";
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
  mergeRoundEvents,
  type RoundEvent,
  type RoundPhase,
  runNavigation,
  runProgressFraction,
} from "./round-machine";

// The pure run machine (C09 §1.1) — walked over the fixture timeline. No React, no
// timers: `advance` is the only motion, navigation is DERIVED from the state a
// transition produced (the autopsy S9 fence).

const SLUG = "s-1";

const OPERATION_BASE = {
  operationId: "operation-1",
  revision: 0,
  createdAt: 1_000,
  roundNumber: 2,
  sourceTarget: { kind: "branch", branch: "feat/truthful-round" },
  askCount: 3,
  gatePlan: { kind: "configured", command: "pnpm check" },
} satisfies Omit<RoundOperationProgressSnapshot, "state">;

const WORKSPACE = { status: "done" } as const;
const WORKER = { status: "done", fileCount: 3 } as const;
const GATE = { status: "passed", durationMs: 1_234, projectCount: 14 } as const;

function operationEvent(
  revision: number,
  state: RoundOperationProgressSnapshot["state"],
  options?: { readonly operationId?: string; readonly createdAt?: number; readonly seq?: number },
): Extract<RoundEvent, { type: "operation" }> {
  return {
    type: "operation",
    snapshot: {
      ...OPERATION_BASE,
      operationId: options?.operationId ?? OPERATION_BASE.operationId,
      createdAt: options?.createdAt ?? OPERATION_BASE.createdAt,
      revision,
      state,
    },
    ...(options?.seq === undefined ? {} : { seq: options.seq }),
  };
}

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
    // Drafting and lens composition are still in flight. Only the terminal composed
    // receipt leaves the run takeover.
    for (const phase of ["reporting", "composing"] as const) {
      const at = FIXTURE_ROUND_TIMELINE.findIndex(
        (_e, i) => roundStateAtTick(i + 1).phase === phase,
      );
      expect(runNavigation(roundStateAtTick(at + 1), SLUG)).toBeNull();
    }
    expect(runNavigation(roundStateAtTick(FIXTURE_ROUND_COMPLETE_TICK), SLUG)).toEqual({
      path: "/s/s-1",
      replace: true,
    });
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

  // ── A round with NO report board still terminates (review finding: the stall) ──
  //
  // A round whose report seat never drafts emits no `report` event at all, and the
  // commonest cause is not exotic: the coding agent ran and changed nothing, so there is
  // no successor account, so the pipeline is not a round and the report seat does not run.
  // `committing` used to accept ONLY `report`, so the lens events and the composed
  // generation were all ignored and the run view watched a live-looking round that never
  // ended — a lie of exactly the kind this surface exists to kill, and one the committed
  // docs ("the surface never locks") assert cannot happen.
  it("ends a completed no-change round without revealing old boards as new", () => {
    const upToCommit: RoundEvent[] = [
      { type: "dispatched" },
      { type: "prep", rows: [] },
      { type: "worker", rows: [] },
      { type: "gate" },
      { type: "committed" },
    ];
    const committing = upToCommit.reduce(advance, initialRoundState);
    expect(committing.phase).toBe("committing");

    const unchanged = advance(committing, { type: "unchanged" });
    expect(unchanged).toEqual({ phase: "unchanged" });
    // The run exits, but old generation boards are never exposed as this round's output.
    expect(runNavigation(unchanged, SLUG)).not.toBeNull();
    expect(canRevealNewBoards(unchanged)).toBe(false);
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

  it("uses the newest durable snapshot across daemon seq restarts", () => {
    const stale = operationEvent(
      4,
      {
        phase: "gate-running",
        workspace: WORKSPACE,
        worker: WORKER,
        gate: { status: "running" },
      },
      { seq: 0 },
    );
    const latest = operationEvent(
      6,
      {
        phase: "report-verifying",
        workspace: WORKSPACE,
        worker: WORKER,
        gate: GATE,
        commits: { status: "done", count: 2 },
        report: { status: "verifying" },
      },
      { seq: 0 },
    );

    const merged = mergeRoundEvents([stale], [latest]);
    expect(merged).toEqual([latest]);
    const reattached = merged.reduce(advance, initialRoundState);
    expect(reattached.phase).toBe("verifying");
    expect(advance(reattached, stale)).toBe(reattached);
  });

  it("prefers a newer operation over an older terminal snapshot", () => {
    const oldTerminal = operationEvent(
      9,
      {
        phase: "completed",
        workspace: WORKSPACE,
        worker: WORKER,
        gate: GATE,
        commits: { status: "done", count: 1 },
        result: {
          kind: "changed",
          report: {
            status: "verified",
            reportBoardId: "report-old",
            generation: "generation-old",
          },
        },
      },
      { operationId: "operation-old", createdAt: 900, seq: 0 },
    );
    const newClaim = operationEvent(
      0,
      { phase: "claimed" },
      {
        operationId: "operation-new",
        createdAt: 1_100,
        seq: 0,
      },
    );

    expect(
      mergeRoundEvents([oldTerminal], [newClaim]).reduce(advance, initialRoundState).phase,
    ).toBe("dispatching");
  });

  it("renders the configured gate's real result, duration, and project count", () => {
    const state = advance(
      initialRoundState,
      operationEvent(5, {
        phase: "gate-settled",
        workspace: WORKSPACE,
        worker: WORKER,
        gate: GATE,
      }),
    );

    expect(state.phase).toBe("gating");
    expect("tail" in state ? state.tail : []).toEqual([
      {
        id: "gate",
        label: "Ran the gate",
        status: "done",
        detail: "pnpm check · 14 projects green · 1.2 s",
      },
    ]);
  });

  it.each([
    [0, "0 commits"],
    [1, "1 commit"],
    [3, "3 commits"],
  ])("renders an exact %i-commit receipt", (count, detail) => {
    const state = advance(
      initialRoundState,
      operationEvent(7, {
        phase: "commits-settled",
        workspace: WORKSPACE,
        worker: WORKER,
        gate: GATE,
        commits: { status: "done", count },
      }),
    );

    expect("tail" in state ? state.tail.at(-1) : undefined).toMatchObject({
      status: "done",
      detail,
    });
  });

  it("keeps a failed gate on the run with the real failed receipt", () => {
    const state = advance(
      initialRoundState,
      operationEvent(5, {
        phase: "failed",
        failure: {
          at: "gate",
          workspace: WORKSPACE,
          worker: WORKER,
          gate: {
            status: "failed",
            reason: "exited 1",
            durationMs: 2_500,
            projectCount: 8,
          },
        },
      }),
    );

    expect(state.phase).toBe("failed");
    expect(runNavigation(state, SLUG)).toBeNull();
    expect("tail" in state ? state.tail.at(-1) : undefined).toEqual({
      id: "gate",
      label: "Ran the gate",
      status: "failed",
      reason: "pnpm check · exited 1 · 2.5 s",
    });
  });

  it("does not navigate until the durable report is verified", () => {
    const drafting = advance(
      initialRoundState,
      operationEvent(8, {
        phase: "report-drafting",
        workspace: WORKSPACE,
        worker: WORKER,
        gate: GATE,
        commits: { status: "done", count: 2 },
        report: { status: "drafting" },
      }),
    );
    const verifying = advance(
      drafting,
      operationEvent(9, {
        phase: "report-verifying",
        workspace: WORKSPACE,
        worker: WORKER,
        gate: GATE,
        commits: { status: "done", count: 2 },
        report: { status: "verifying" },
      }),
    );
    const legacyEarlyTerminal = advance(verifying, { type: "composed", generation: "too-early" });
    const completed = advance(
      legacyEarlyTerminal,
      operationEvent(10, {
        phase: "completed",
        workspace: WORKSPACE,
        worker: WORKER,
        gate: GATE,
        commits: { status: "done", count: 2 },
        result: {
          kind: "changed",
          report: {
            status: "verified",
            reportBoardId: "report-2",
            generation: "generation-2",
          },
        },
      }),
    );

    expect(runNavigation(drafting, SLUG)).toBeNull();
    expect(runNavigation(verifying, SLUG)).toBeNull();
    expect(legacyEarlyTerminal).toBe(verifying);
    expect(runNavigation(completed, SLUG)).toEqual({ path: "/s/s-1", replace: true });
  });
});
