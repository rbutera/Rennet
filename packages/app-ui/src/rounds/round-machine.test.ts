import type { RoundOperationProgressSnapshot } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import {
  FIXTURE_ROUND_COMPLETE_TICK,
  FIXTURE_ROUND_TIMELINE,
  reportBoardFixture,
  roundStateAtTick,
} from "../test/fixtures/rounds";
import {
  advance,
  canRevealNewBoards,
  initialRoundState,
  mergeRoundEvents,
  type RoundEvent,
  type RoundPhase,
  type RoundState,
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
} satisfies Omit<RoundOperationProgressSnapshot, "state">;

const WORKSPACE = { status: "done" } as const;
const WORKER = { status: "done", fileCount: 3 } as const;
const GATE = { status: "passed", durationMs: 1_234, projectCount: 14 } as const;

function operationEvent(
  revision: number,
  state: RoundOperationProgressSnapshot["state"],
  options?: {
    readonly operationId?: string;
    readonly createdAt?: number;
    readonly seq?: number;
    readonly draining?: boolean;
    readonly rerunRequested?: boolean;
    readonly roundNumber?: number;
  },
): Extract<RoundEvent, { type: "operation" }> {
  return {
    type: "operation",
    snapshot: {
      ...OPERATION_BASE,
      operationId: options?.operationId ?? OPERATION_BASE.operationId,
      createdAt: options?.createdAt ?? OPERATION_BASE.createdAt,
      roundNumber: options?.roundNumber ?? OPERATION_BASE.roundNumber,
      revision,
      ...(options?.draining === undefined ? {} : { draining: options.draining }),
      ...(options?.rerunRequested === undefined ? {} : { rerunRequested: options.rerunRequested }),
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

  it("hands off when the report is readable, before board regeneration finishes", () => {
    // Watching phases keep the reviewer on the run route (no effect-driven redirect).
    for (const phase of ["dispatching", "preparing", "working", "committing"] as const) {
      const at = FIXTURE_ROUND_TIMELINE.findIndex(
        (_e, i) => roundStateAtTick(i + 1).phase === phase,
      );
      expect(runNavigation(roundStateAtTick(at + 1), SLUG)).toBeNull();
    }
    // The report already exists in both phases. It leads the board surface while lens
    // composition remains in flight; the reveal itself stays completed-only.
    for (const phase of ["reporting", "composing"] as const) {
      const at = FIXTURE_ROUND_TIMELINE.findIndex(
        (_e, i) => roundStateAtTick(i + 1).phase === phase,
      );
      expect(runNavigation(roundStateAtTick(at + 1), SLUG)).toEqual({
        path: "/s/s-1",
        replace: true,
      });
      expect(canRevealNewBoards(roundStateAtTick(at + 1))).toBe(false);
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
      { phase: "worker-settled", workspace: WORKSPACE, worker: WORKER },
      { seq: 0 },
    );
    const latest = operationEvent(
      6,
      {
        phase: "report-verifying",
        workspace: WORKSPACE,
        worker: WORKER,
        commits: { status: "done", count: 2 },
        report: {
          status: "verifying",
          reportBoardId: "report-2",
          generation: "generation-2",
        },
      },
      { seq: 0 },
    );

    const merged = mergeRoundEvents([stale], [latest]);
    expect(merged).toEqual([latest]);
    const reattached = merged.reduce(advance, initialRoundState);
    expect(reattached.phase).toBe("verifying");
    expect(advance(reattached, stale)).toBe(reattached);
  });

  it("keeps operation-scoped report and lens progress beside the durable drafting snapshot", () => {
    const drafting = operationEvent(
      8,
      {
        phase: "report-drafting",
        workspace: WORKSPACE,
        worker: WORKER,
        commits: { status: "done", count: 2 },
        report: { status: "drafting" },
      },
      { seq: 10 },
    );
    const report = {
      type: "report",
      operationId: OPERATION_BASE.operationId,
      operationRevision: 8,
      reportBoardId: "report-2",
      report: { ...reportBoardFixture, boardId: "report-2" },
      seq: 11,
    } satisfies RoundEvent;
    const lens = {
      type: "lens",
      operationId: OPERATION_BASE.operationId,
      operationRevision: 8,
      lanes: [
        { id: "sequence", label: "Sequence", status: "running" },
        { id: "decisions", label: "Decisions", status: "queued" },
      ],
      seq: 12,
    } satisfies RoundEvent;

    const merged = mergeRoundEvents([drafting], [report, lens]);
    expect(merged).toEqual([drafting, report, lens]);
    const state = merged.reduce(advance, initialRoundState);

    expect(state).toMatchObject({
      phase: "composing",
      reportBoardId: "report-2",
      report: report.report,
      lanes: lens.lanes,
      operation: { operationId: OPERATION_BASE.operationId, revision: 8 },
    });
    expect(runNavigation(state, SLUG)).toEqual({ path: "/s/s-1", replace: true });
    expect(canRevealNewBoards(state)).toBe(false);
  });

  it("refuses report progress from a different durable operation", () => {
    const drafting = operationEvent(
      8,
      {
        phase: "report-drafting",
        workspace: WORKSPACE,
        worker: WORKER,
        commits: { status: "done", count: 2 },
        report: { status: "drafting" },
      },
      { seq: 10 },
    );
    const foreign = {
      type: "report",
      operationId: "operation-foreign",
      operationRevision: 8,
      reportBoardId: "report-foreign",
      report: { ...reportBoardFixture, boardId: "report-foreign" },
      seq: 11,
    } satisfies RoundEvent;

    const merged = mergeRoundEvents([drafting], [foreign]);
    expect(merged).toEqual([drafting]);
    expect(merged.reduce(advance, initialRoundState).phase).toBe("drafting-report");
  });

  it("keeps the readable report attached when the durable phase advances to verification", () => {
    const verifying = operationEvent(
      9,
      {
        phase: "report-verifying",
        workspace: WORKSPACE,
        worker: WORKER,
        commits: { status: "done", count: 2 },
        report: {
          status: "verifying",
          reportBoardId: "report-2",
          generation: "generation-2",
        },
      },
      { seq: 13 },
    );
    const report = {
      type: "report",
      operationId: OPERATION_BASE.operationId,
      operationRevision: 8,
      reportBoardId: "report-2",
      report: { ...reportBoardFixture, boardId: "report-2" },
      seq: 11,
    } satisfies RoundEvent;
    const lens = {
      type: "lens",
      operationId: OPERATION_BASE.operationId,
      operationRevision: 8,
      lanes: [{ id: "sequence", label: "Sequence", status: "done", verdict: "reworked" }],
      seq: 12,
    } satisfies RoundEvent;

    const merged = mergeRoundEvents([verifying, report, lens], []);
    expect(merged).toEqual([verifying, report, lens]);
    const state = merged.reduce(advance, initialRoundState);
    expect(state).toMatchObject({
      phase: "verifying",
      reportBoardId: "report-2",
      report: report.report,
      lanes: lens.lanes,
    });
    expect(canRevealNewBoards(state)).toBe(false);
  });

  it("stops labelling the round report as running once the lens fan-out starts", () => {
    const drafting = operationEvent(4, {
      phase: "report-drafting",
      workspace: WORKSPACE,
      worker: WORKER,
      commits: { status: "done", count: 2 },
      report: { status: "drafting" },
    });
    const draftingState = advance(initialRoundState, drafting);
    const runningReportRow = "tail" in draftingState ? draftingState.tail.at(-1) : undefined;
    // While the report seat really is running, the row says so.
    expect(runningReportRow).toEqual({
      id: "report",
      label: "Drafting the round report",
      status: "running",
    });

    const report = {
      type: "report",
      operationId: OPERATION_BASE.operationId,
      operationRevision: 4,
      reportBoardId: "report-9",
      report: { ...reportBoardFixture, boardId: "report-9" },
    } satisfies RoundEvent;
    const reporting = advance(draftingState, report);
    // #725 7.4 — the report has been handed off; the phase that is now RUNNING is the lens
    // fan-out, so the report's own row must settle rather than keep spinning over it.
    const settledReportRow = "tail" in reporting ? reporting.tail.at(-1) : undefined;
    expect(settledReportRow?.status).toBe("done");
    expect(settledReportRow?.label).toBe("Drafted the round report");

    const lens = {
      type: "lens",
      operationId: OPERATION_BASE.operationId,
      operationRevision: 4,
      lanes: [{ id: "sequence", label: "Sequence", status: "running" }],
    } satisfies RoundEvent;
    const composing = advance(reporting, lens);
    expect(composing.phase).toBe("composing");
    expect("tail" in composing ? composing.tail.at(-1)?.status : undefined).toBe("done");
  });

  it("lands a client reconnecting mid-fan-out on the lens phase, not on the report's", () => {
    // The durable operation has no phase of its own for the lens fan-out and stays in
    // `report-drafting` throughout it. The handoff is what tells the two apart.
    const handedOff = operationEvent(5, {
      phase: "report-drafting",
      workspace: WORKSPACE,
      worker: WORKER,
      commits: { status: "done", count: 2 },
      report: { status: "handed-off", reportBoardId: "report-9", generation: "gen-9" },
    });
    const state = advance(initialRoundState, handedOff);
    expect(state.phase).toBe("reporting");
    expect("tail" in state ? state.tail.at(-1) : undefined).toMatchObject({
      id: "report",
      status: "done",
    });
    // …and the lens frame it receives next opens the regeneration block.
    const composing = advance(state, {
      type: "lens",
      operationId: OPERATION_BASE.operationId,
      operationRevision: 5,
      lanes: [{ id: "noise", label: "Noise", status: "drafted" }],
    });
    expect(composing).toMatchObject({ phase: "composing" });
  });

  it("keeps a readable report attached when the same durable operation later fails", () => {
    const drafting = operationEvent(
      8,
      {
        phase: "report-drafting",
        workspace: WORKSPACE,
        worker: WORKER,
        commits: { status: "done", count: 2 },
        report: { status: "drafting" },
      },
      { seq: 10 },
    );
    const report = {
      type: "report",
      operationId: OPERATION_BASE.operationId,
      operationRevision: 8,
      reportBoardId: "report-2",
      report: { ...reportBoardFixture, boardId: "report-2" },
      seq: 11,
    } satisfies RoundEvent;
    const failed = operationEvent(
      9,
      {
        phase: "failed",
        failure: {
          at: "report-drafting",
          workspace: WORKSPACE,
          worker: WORKER,
          commits: { status: "done", count: 2 },
          report: {
            status: "failed",
            step: "drafting",
            reason: "lens regeneration failed",
          },
        },
      },
      { seq: 12 },
    );

    const merged = mergeRoundEvents([drafting, report], [failed]);
    expect(merged).toEqual([drafting, failed, report]);
    expect(merged.reduce(advance, initialRoundState)).toMatchObject({
      phase: "failed",
      reason: "lens regeneration failed",
      reportAttemptRevision: 8,
      reportHandoff: {
        reportBoardId: "report-2",
        report: report.report,
      },
      operation: { operationId: OPERATION_BASE.operationId, revision: 9 },
    });
  });

  it("uses the persisted handoff revision when a queued rerun precedes failure", () => {
    const handoffAttempt = operationEvent(
      8,
      {
        phase: "report-drafting",
        workspace: WORKSPACE,
        worker: WORKER,
        commits: { status: "done", count: 2 },
        report: { status: "drafting" },
      },
      { seq: 10 },
    );
    const report = {
      type: "report",
      operationId: OPERATION_BASE.operationId,
      operationRevision: 8,
      reportBoardId: "report-durable-handoff",
      report: { ...reportBoardFixture, boardId: "report-durable-handoff" },
      seq: 11,
    } satisfies RoundEvent;
    const queuedRerun = operationEvent(
      9,
      {
        phase: "report-drafting",
        workspace: WORKSPACE,
        worker: WORKER,
        commits: { status: "done", count: 2 },
        report: { status: "drafting" },
      },
      { seq: 12, rerunRequested: true },
    );
    const failed = operationEvent(
      10,
      {
        phase: "failed",
        failure: {
          at: "report-drafting",
          workspace: WORKSPACE,
          worker: WORKER,
          commits: { status: "done", count: 2 },
          report: {
            status: "failed",
            step: "drafting",
            reason: "lens regeneration failed",
          },
        },
      },
      { seq: 13, rerunRequested: true },
    );

    const queued = mergeRoundEvents([handoffAttempt, report], [queuedRerun]);
    expect(queued).toEqual([handoffAttempt, queuedRerun, report]);
    expect(queued.reduce(advance, initialRoundState)).toMatchObject({
      phase: "reporting",
      reportProgressRevision: 8,
      reportBoardId: "report-durable-handoff",
      report: report.report,
      operation: { operationId: OPERATION_BASE.operationId, revision: 9 },
    });

    const merged = mergeRoundEvents(queued, [failed]);

    expect(merged).toEqual([handoffAttempt, failed, report]);
    expect(merged.reduce(advance, initialRoundState)).toMatchObject({
      phase: "failed",
      reason: "lens regeneration failed",
      reportAttemptRevision: 8,
      reportHandoff: {
        reportBoardId: "report-durable-handoff",
        report: report.report,
      },
      operation: { operationId: OPERATION_BASE.operationId, revision: 10 },
    });
  });

  it("does not replay older lens progress while a queued operation is genuinely retrying", () => {
    const handoffAttempt = operationEvent(
      8,
      {
        phase: "report-drafting",
        workspace: WORKSPACE,
        worker: WORKER,
        commits: { status: "done", count: 2 },
        report: { status: "drafting" },
      },
      { seq: 10 },
    );
    const report = {
      type: "report",
      operationId: OPERATION_BASE.operationId,
      operationRevision: 8,
      reportBoardId: "report-durable-handoff",
      report: { ...reportBoardFixture, boardId: "report-durable-handoff" },
      seq: 11,
    } satisfies RoundEvent;
    const staleLens = {
      type: "lens",
      operationId: OPERATION_BASE.operationId,
      operationRevision: 8,
      lanes: [{ id: "sequence", label: "Sequence", status: "done", verdict: "reworked" }],
      seq: 12,
    } satisfies RoundEvent;
    const retryDrafting = operationEvent(
      11,
      {
        phase: "report-drafting",
        workspace: WORKSPACE,
        worker: WORKER,
        commits: { status: "done", count: 2 },
        report: { status: "drafting" },
      },
      { seq: 20, rerunRequested: true },
    );

    const merged = mergeRoundEvents([handoffAttempt, report, staleLens], [retryDrafting]);

    expect(merged).toEqual([handoffAttempt, retryDrafting, report]);
    expect(merged.reduce(advance, initialRoundState)).toMatchObject({
      phase: "reporting",
      reportProgressRevision: 8,
      reportBoardId: "report-durable-handoff",
      operation: { operationId: OPERATION_BASE.operationId, revision: 11 },
    });
  });

  it("does not attach a previous attempt's report when a same-operation retry fails", () => {
    const priorDrafting = operationEvent(
      8,
      {
        phase: "report-drafting",
        workspace: WORKSPACE,
        worker: WORKER,
        commits: { status: "done", count: 2 },
        report: { status: "drafting" },
      },
      { seq: 10 },
    );
    const priorReport = {
      type: "report",
      operationId: OPERATION_BASE.operationId,
      operationRevision: 8,
      reportBoardId: "report-prior-attempt",
      report: { ...reportBoardFixture, boardId: "report-prior-attempt" },
      seq: 11,
    } satisfies RoundEvent;
    const retryDrafting = operationEvent(
      10,
      {
        phase: "report-drafting",
        workspace: WORKSPACE,
        worker: WORKER,
        commits: { status: "done", count: 2 },
        report: { status: "drafting" },
      },
      { seq: 20 },
    );
    const failedRetry = operationEvent(
      11,
      {
        phase: "failed",
        failure: {
          at: "report-drafting",
          workspace: WORKSPACE,
          worker: WORKER,
          commits: { status: "done", count: 2 },
          report: {
            status: "failed",
            step: "drafting",
            reason: "retry regeneration failed",
          },
        },
      },
      { seq: 21 },
    );

    const merged = mergeRoundEvents([priorDrafting, priorReport, retryDrafting], [failedRetry]);
    expect(merged).toEqual([failedRetry]);
    expect(merged.reduce(advance, initialRoundState)).toMatchObject({
      phase: "failed",
      reason: "retry regeneration failed",
    });
    expect("reportHandoff" in merged.reduce(advance, initialRoundState)).toBe(false);
  });

  it("chooses the newest retry attempt before seq after a daemon restart", () => {
    const verifying = operationEvent(
      11,
      {
        phase: "report-verifying",
        workspace: WORKSPACE,
        worker: WORKER,
        commits: { status: "done", count: 2 },
        report: {
          status: "verifying",
          reportBoardId: "report-current-attempt",
          generation: "generation-current-attempt",
        },
      },
      { seq: 0 },
    );
    const oldReport = {
      type: "report",
      operationId: OPERATION_BASE.operationId,
      operationRevision: 8,
      reportBoardId: "report-old-attempt",
      report: { ...reportBoardFixture, boardId: "report-old-attempt" },
      seq: 100,
    } satisfies RoundEvent;
    const oldLens = {
      type: "lens",
      operationId: OPERATION_BASE.operationId,
      operationRevision: 8,
      lanes: [{ id: "sequence", label: "Sequence", status: "running" }],
      seq: 101,
    } satisfies RoundEvent;
    const currentReport = {
      type: "report",
      operationId: OPERATION_BASE.operationId,
      operationRevision: 10,
      reportBoardId: "report-current-attempt",
      report: { ...reportBoardFixture, boardId: "report-current-attempt" },
      seq: 1,
    } satisfies RoundEvent;
    const currentLens = {
      type: "lens",
      operationId: OPERATION_BASE.operationId,
      operationRevision: 10,
      lanes: [{ id: "sequence", label: "Sequence", status: "done", verdict: "reworked" }],
      seq: 2,
    } satisfies RoundEvent;

    const merged = mergeRoundEvents([oldReport, oldLens, verifying], [currentReport, currentLens]);
    expect(merged).toEqual([verifying, currentReport, currentLens]);
    expect(merged.reduce(advance, initialRoundState)).toMatchObject({
      phase: "verifying",
      reportBoardId: "report-current-attempt",
      report: currentReport.report,
      lanes: currentLens.lanes,
    });
  });

  it("keeps read seq 12 over a later-arriving streamed seq 11 lens snapshot", () => {
    const drafting = operationEvent(
      8,
      {
        phase: "report-drafting",
        workspace: WORKSPACE,
        worker: WORKER,
        commits: { status: "done", count: 2 },
        report: { status: "drafting" },
      },
      { seq: 10 },
    );
    const report = {
      type: "report",
      operationId: OPERATION_BASE.operationId,
      operationRevision: 8,
      reportBoardId: "report-2",
      report: { ...reportBoardFixture, boardId: "report-2" },
      seq: 10,
    } satisfies RoundEvent;
    const readLens = {
      type: "lens",
      operationId: OPERATION_BASE.operationId,
      operationRevision: 8,
      lanes: [{ id: "sequence", label: "Sequence", status: "done", verdict: "reworked" }],
      seq: 12,
    } satisfies RoundEvent;
    const streamedLens = {
      type: "lens",
      operationId: OPERATION_BASE.operationId,
      operationRevision: 8,
      lanes: [{ id: "sequence", label: "Sequence", status: "running" }],
      seq: 11,
    } satisfies RoundEvent;

    const merged = mergeRoundEvents([drafting, report, readLens], [streamedLens]);
    expect(merged).toEqual([drafting, report, readLens]);
    expect(merged.reduce(advance, initialRoundState)).toMatchObject({
      phase: "composing",
      lanes: readLens.lanes,
    });
  });

  it("does not replay a failed attempt's report and lenses into the same operation retry", () => {
    const retryDrafting = operationEvent(
      10,
      {
        phase: "report-drafting",
        workspace: WORKSPACE,
        worker: WORKER,
        commits: { status: "done", count: 2 },
        report: { status: "drafting" },
      },
      { seq: 20 },
    );
    const priorReport = {
      type: "report",
      operationId: OPERATION_BASE.operationId,
      operationRevision: 8,
      reportBoardId: "report-prior-attempt",
      report: { ...reportBoardFixture, boardId: "report-prior-attempt" },
      seq: 11,
    } satisfies RoundEvent;
    const priorLens = {
      type: "lens",
      operationId: OPERATION_BASE.operationId,
      operationRevision: 8,
      lanes: [{ id: "sequence", label: "Sequence", status: "done", verdict: "reworked" }],
      seq: 12,
    } satisfies RoundEvent;

    const merged = mergeRoundEvents([priorReport, priorLens], [retryDrafting]);
    expect(merged).toEqual([retryDrafting]);
    expect(merged.reduce(advance, initialRoundState).phase).toBe("drafting-report");
  });

  it("prefers a newer operation over an older terminal snapshot", () => {
    const oldTerminal = operationEvent(
      9,
      {
        phase: "completed",
        workspace: WORKSPACE,
        worker: WORKER,
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

  it("keeps reveal terminal-only while a readable report is being verified", () => {
    const drafting = advance(
      initialRoundState,
      operationEvent(8, {
        phase: "report-drafting",
        workspace: WORKSPACE,
        worker: WORKER,
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
        commits: { status: "done", count: 2 },
        report: {
          status: "verifying",
          reportBoardId: "report-2",
          generation: "generation-2",
        },
      }),
    );
    const legacyEarlyTerminal = advance(verifying, { type: "composed", generation: "too-early" });
    const completed = advance(
      legacyEarlyTerminal,
      operationEvent(10, {
        phase: "completed",
        workspace: WORKSPACE,
        worker: WORKER,
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
    expect(runNavigation(verifying, SLUG)).toEqual({ path: "/s/s-1", replace: true });
    expect(canRevealNewBoards(verifying)).toBe(false);
    expect(legacyEarlyTerminal).toBe(verifying);
    expect(runNavigation(completed, SLUG)).toEqual({ path: "/s/s-1", replace: true });
  });

  it("keeps Reveal gated while Return drains after the report handoff", () => {
    const completedState: RoundOperationProgressSnapshot["state"] = {
      phase: "completed",
      workspace: WORKSPACE,
      worker: WORKER,
      commits: { status: "done", count: 2 },
      result: {
        kind: "changed",
        report: {
          status: "verified",
          reportBoardId: "report-2",
          generation: "generation-2",
        },
      },
    };
    const draining = advance(
      initialRoundState,
      operationEvent(10, completedState, { draining: true }),
    );

    expect(draining.phase).toBe("verifying");
    expect(runNavigation(draining, SLUG)).toEqual({ path: "/s/s-1", replace: true });
    expect(canRevealNewBoards(draining)).toBe(false);

    const returned = advance(draining, operationEvent(11, completedState, { draining: false }));
    expect(returned.phase).toBe("composed");
    expect(runNavigation(returned, SLUG)).toEqual({ path: "/s/s-1", replace: true });
    expect(canRevealNewBoards(returned)).toBe(true);
  });

  it("treats a queued rerun receipt as the next dispatch instead of round-one completion", () => {
    const queued = advance(
      initialRoundState,
      operationEvent(
        11,
        {
          phase: "completed",
          workspace: WORKSPACE,
          worker: WORKER,
          commits: { status: "done", count: 2 },
          result: {
            kind: "changed",
            report: {
              status: "verified",
              reportBoardId: "report-1",
              generation: "generation-1",
            },
          },
        },
        { draining: true, rerunRequested: true },
      ),
    );

    expect(queued.phase).toBe("dispatching");
    expect(runNavigation(queued, SLUG)).toBeNull();
  });
});

// C14 §8 / D7 — the CLIENT half of the unbounded-loop proof. The server machine test
// (`packages/server/src/round-loop-unbounded.test.ts`) proves dispatch never caps; this
// proves the run machine the reviewer actually watches carries no ordinal branch either.
//
// The interesting part is that state is NOT reset between rounds: round k's terminal
// `composed` is the state round k+1's first snapshot arrives into, so supersession
// (`isNewerOperation`) is exercised at every depth rather than only at depth 1. An ordinal
// branch — a "round two is different" arm, a cap that stops superseding — shows up as a
// differing phase SEQUENCE, not a differing set.

/** One durable round's full progress, as the daemon projects it. */
function roundLifecycle(ordinal: number): readonly Extract<RoundEvent, { type: "operation" }>[] {
  // The ordinal travels on the snapshot exactly as the daemon sends it, so a branch on
  // `roundNumber` — the one field that carries depth into the client — is reachable here.
  const identity = {
    operationId: `operation-${ordinal}`,
    createdAt: 1_000 * ordinal,
    roundNumber: ordinal,
  };
  const settledPrefix = { workspace: WORKSPACE, worker: WORKER, gate: GATE } as const;
  const commits = { status: "done", count: 2 } as const;
  return [
    operationEvent(0, { phase: "claimed" }, identity),
    operationEvent(1, { phase: "prepared", workspace: WORKSPACE }, identity),
    operationEvent(
      2,
      { phase: "worker-running", workspace: WORKSPACE, worker: { status: "running" } },
      identity,
    ),
    operationEvent(
      4,
      { phase: "committing", ...settledPrefix, commits: { status: "running" } },
      identity,
    ),
    operationEvent(
      5,
      { phase: "report-drafting", ...settledPrefix, commits, report: { status: "drafting" } },
      identity,
    ),
    operationEvent(
      6,
      {
        phase: "report-verifying",
        ...settledPrefix,
        commits,
        report: {
          status: "verifying",
          reportBoardId: `report-${ordinal}`,
          generation: `generation-${ordinal}`,
        },
      },
      identity,
    ),
    operationEvent(
      7,
      {
        phase: "completed",
        ...settledPrefix,
        commits,
        result: {
          kind: "changed",
          report: {
            status: "verified",
            reportBoardId: `report-${ordinal}`,
            generation: `generation-${ordinal}`,
          },
        },
      },
      identity,
    ),
  ];
}

/** The phase sequence one round produces. Identical for every round, at any depth. */
const EXPECTED_ROUND_PHASES: readonly RoundPhase[] = [
  "dispatching",
  "preparing",
  "working",
  "committing",
  "drafting-report",
  // `report-verifying` carrying a report identity is the run view's `verifying`, not the
  // identity-less `verifying-report` — the phase names differ by what the daemon projected.
  "verifying",
  "composed",
];

function walkRounds(
  rounds: number,
  reduce: (state: RoundState, event: RoundEvent) => RoundState = advance,
): readonly (readonly RoundPhase[])[] {
  let state = initialRoundState;
  const perRound: RoundPhase[][] = [];
  for (let ordinal = 1; ordinal <= rounds; ordinal += 1) {
    const phases: RoundPhase[] = [];
    for (const event of roundLifecycle(ordinal)) {
      state = reduce(state, event);
      phases.push(state.phase);
    }
    perRound.push(phases);
  }
  return perRound;
}

describe("round-machine — arbitrary depth holds by construction (C14 §8, D7)", () => {
  for (const rounds of [1, 2, 3, 5, 8]) {
    it(`walks ${rounds} rounds back to back with the same phase sequence each time`, () => {
      const perRound = walkRounds(rounds);

      expect(perRound).toHaveLength(rounds);
      for (const [index, phases] of perRound.entries()) {
        // ORDERED. A set of phases is satisfied by a machine that visits them out of order
        // or stalls and recovers; the sequence is not.
        expect(phases, `round ${index + 1}`).toEqual(EXPECTED_ROUND_PHASES);
      }
    });
  }

  it("the eighth round's terminal state names its OWN generation, not the first's", () => {
    let state: RoundState = initialRoundState;
    const generations: string[] = [];
    for (let ordinal = 1; ordinal <= 8; ordinal += 1) {
      state = roundLifecycle(ordinal).reduce(advance, state);
      generations.push("newGeneration" in state ? (state.newGeneration ?? "") : "");
    }

    expect(generations).toEqual(Array.from({ length: 8 }, (_, index) => `generation-${index + 1}`));
    expect(state.phase).toBe("composed");
  });

  it("POSITIVE CONTROL: a machine that stops superseding after two rounds fails the walk", () => {
    // The client-side shape of the same defect: the reducer refuses a third operation, so
    // round three never leaves round two's terminal state. Rounds 1 and 2 stay identical to
    // a healthy loop — which is exactly why three rounds cannot prove the class.
    let landed = 0;
    const capped = (state: RoundState, event: RoundEvent): RoundState => {
      if (event.type === "operation" && event.snapshot.state.phase === "claimed") landed += 1;
      return landed > 2 ? state : advance(state, event);
    };
    const perRound = walkRounds(4, capped);

    expect(perRound[0]).toEqual(EXPECTED_ROUND_PHASES);
    expect(perRound[1]).toEqual(EXPECTED_ROUND_PHASES);
    expect(perRound[2]).not.toEqual(EXPECTED_ROUND_PHASES);
    expect(perRound[3]).not.toEqual(EXPECTED_ROUND_PHASES);
    // …and the same walk over the real reducer passes, so the assertion discriminates
    // rather than merely being strict.
    for (const phases of walkRounds(4)) expect(phases).toEqual(EXPECTED_ROUND_PHASES);
  });
});

describe("generation usage rides the lens frame (#737)", () => {
  const USAGE = {
    turns: 3,
    unmeasuredTurns: 0,
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 300,
    cacheCreationTokens: 0,
    totalTokens: 1500,
    reportedUsd: null,
  };
  const reportingState = () =>
    advance(
      initialRoundState,
      operationEvent(6, {
        phase: "report-drafting",
        workspace: WORKSPACE,
        worker: WORKER,
        commits: { status: "done", count: 2 },
        report: { status: "handed-off", reportBoardId: "report-9", generation: "gen-9" },
      }),
    );

  it("lands the frame's usage on the state and replaces it with a later frame's", () => {
    const composing = advance(reportingState(), {
      type: "lens",
      operationId: OPERATION_BASE.operationId,
      operationRevision: 6,
      lanes: [{ id: "noise", label: "Noise", status: "drafted" }],
      usage: USAGE,
    });
    expect(composing).toMatchObject({ phase: "composing", usage: { totalTokens: 1500 } });
    // Cumulative on the server: a later frame REPLACES, it is never summed twice here.
    const later = advance(composing, {
      type: "lens",
      operationId: OPERATION_BASE.operationId,
      operationRevision: 6,
      lanes: [{ id: "noise", label: "Noise", status: "drafted" }],
      usage: { ...USAGE, turns: 5, totalTokens: 2600 },
    });
    expect(later).toMatchObject({ usage: { turns: 5, totalTokens: 2600 } });
    // A frame that carries none keeps the last honest figure.
    const none = advance(later, {
      type: "lens",
      operationId: OPERATION_BASE.operationId,
      operationRevision: 6,
      lanes: [{ id: "noise", label: "Noise", status: "done", verdict: "reworked" }],
    });
    expect(none).toMatchObject({ usage: { turns: 5, totalTokens: 2600 } });
    // Positive control: a state that never saw a usage frame carries none.
    const untouched = reportingState();
    expect("usage" in untouched ? untouched.usage : undefined).toBeUndefined();
  });
});
