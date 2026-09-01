import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AskLogStore } from "@rennet/adapters";
import type {
  AskOccurrence,
  ComposedHandoffBundle,
  Patchset,
  Review,
  RoundRecord,
} from "@rennet/protocol";
import { sha256Hex } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import { createDispatchRuntime, type DispatchDeps } from "./dispatch";
import { roundHandlers } from "./dispatch/round";
import { roundNumberForDispatch } from "./session/round-number";

// C14 §8 / D7 — the review round loop is UNBOUNDED BY CONSTRUCTION, and this file is the
// machine test that says so for arbitrary N rather than for some particular N.
//
// The distinction matters and it is the whole point of the file: a three-round journey
// disproves a cap of two. It says nothing about a cap of three, a "round two" special case,
// or an ordinal branch buried in the crash-repair pass. So this drives the REAL
// `round.dispatch` handler through N dispatch/land cycles and asserts that every cycle's
// observable transitions are the SAME ORDERED SEQUENCE — not the same set. A set assertion
// (`toContain` per step) is satisfied by a loop that does the right things in the wrong
// order, and by a cycle that quietly gains or loses a step at depth.
//
// The trace is deliberately ordinal-free: cycle-specific ids (patchset, dispatch identity,
// ask id) are normalised out, so two cycles differ in the trace ONLY if the machine
// behaved differently. The ordinal itself is carried alongside as DATA (`roundNumber`,
// which only ever counts) and asserted to grow without ever reaching the transitions.
//
// The positive control at the foot introduces the defect this whole section exists to
// forbid — a dispatch capped by round ordinal — and asserts the uniformity check FAILS on
// it. Without that, the assertion above is a green bar with nothing behind it.

const REVIEW_ID = "review-1";

interface DispatchResult {
  readonly workOrder: ComposedHandoffBundle;
  readonly dispatched: boolean;
}

type DispatchHandler = (input: { readonly reviewId: string }) => Promise<unknown>;

function patchsetAt(index: number): Patchset {
  return { id: `ps-${index}`, createdAt: "", truncated: false, files: [] } as unknown as Patchset;
}

/** The loop's driver: one mutable own-branch review whose active patchset advances as each
 *  round lands, over a real durable ask log and a real `round.dispatch` handler. */
function loopHarness() {
  const patchsets: Patchset[] = [patchsetAt(1)];
  const review = {
    id: REVIEW_ID,
    repositoryRoot: "/repo",
    activePatchsetId: "ps-1",
    patchsets,
    dispositions: [],
    status: "current",
  } as unknown as Review & { activePatchsetId: string };
  const records: RoundRecord[] = [];
  const store = new AskLogStore(mkdtempSync(join(tmpdir(), "rennet-round-loop-")));
  const kicks: {
    readonly sourcePatchsetId: string;
    readonly dispatchId: string;
    readonly askOccurrences: readonly AskOccurrence[];
  }[] = [];
  const dispatchRound = vi.fn<NonNullable<DispatchDeps["dispatchRound"]>>(async (input) => {
    kicks.push({
      sourcePatchsetId: input.sourcePatchsetId,
      dispatchId: input.dispatchId,
      askOccurrences: input.askOccurrences,
    });
    return undefined;
  });
  const rt = createDispatchRuntime({
    askLog: store,
    service: { reviewById: (id: string) => (id === REVIEW_ID ? review : undefined) },
    dispatchRound,
    roundRecordsForReview: () => records,
  } as unknown as DispatchDeps);

  /** Land the round the last kick started: record it durably and mint the successor patchset,
   *  exactly as a completed regeneration does. */
  const land = (): { readonly generation: string; readonly successor: string } => {
    const kick = kicks.at(-1);
    if (kick === undefined) throw new Error("Nothing was dispatched to land.");
    const successor = `ps-${patchsets.length + 1}`;
    const generation = `gen:${successor}`;
    records.push({
      asksDispatched: kick.askOccurrences.map((occurrence) => occurrence.id),
      dispatchId: kick.dispatchId,
      sourcePatchsetId: kick.sourcePatchsetId,
      askOccurrences: [...kick.askOccurrences],
      workerCommitRange: { from: `c${records.length}`, to: `c${records.length + 1}` },
      boardGeneration: generation,
      reportBoard: `report:${generation}`,
      outcome: "completed",
      regeneration: "completed",
      diff: "+worker change",
      changedPaths: ["src/x.ts"],
    } as unknown as RoundRecord);
    patchsets.push(patchsetAt(patchsets.length + 1));
    review.activePatchsetId = successor;
    return { generation, successor };
  };

  return {
    store,
    records,
    kicks,
    land,
    dispatchRound,
    dispatch: roundHandlers(rt)["round.dispatch"] as DispatchHandler,
    stagedAskIds: () => Object.keys(store.readProjection(REVIEW_ID).stagedAsks),
  };
}

/** One cycle's observable transitions, with every cycle-specific identity normalised away.
 *  Anything ordinal-dependent in the machine shows up here as a differing sequence. */
const EXPECTED_CYCLE: readonly string[] = [
  "empty-queue:dispatched=false",
  "staged:1",
  "dispatch:dispatched=true",
  "work-order:tasks=1",
  "kick:source=active,occurrences=1",
  "drained:staged=0",
  "landed:successor=active",
];

interface CycleObservation {
  readonly trace: readonly string[];
  readonly roundNumber: number;
  readonly dispatchId: string;
}

/** Drive the real handler through `cycles` complete dispatch/land cycles, recording each
 *  cycle's ordered transitions. `dispatchFor` lets the positive control substitute a capped
 *  handler at exactly the layer a cap would live. */
async function driveRoundLoop(
  cycles: number,
  dispatchFor: (harness: ReturnType<typeof loopHarness>) => DispatchHandler = (h) => h.dispatch,
): Promise<readonly CycleObservation[]> {
  const harness = loopHarness();
  const dispatch = dispatchFor(harness);
  const observations: CycleObservation[] = [];

  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    const trace: string[] = [];
    const sourceIndex = harness.records.length + 1;

    // An exhausted ask queue refuses — the only refusal the loop has, and it must read the
    // same at depth 1 and depth N.
    const idle = (await dispatch({ reviewId: REVIEW_ID })) as DispatchResult;
    trace.push(`empty-queue:dispatched=${idle.dispatched}`);

    harness.store.append(REVIEW_ID, {
      kind: "stage",
      ask: {
        id: `ask-${cycle}`,
        anchor: `src/x.ts:${cycle}`,
        type: "request-change",
        body: `round ${cycle} ask`,
      },
    });
    trace.push(`staged:${harness.stagedAskIds().length}`);

    const result = (await dispatch({ reviewId: REVIEW_ID })) as DispatchResult;
    trace.push(`dispatch:dispatched=${result.dispatched}`);
    trace.push(`work-order:tasks=${result.workOrder.tasks.length}`);

    const kick = harness.kicks.at(-1);
    const kickedSource =
      kick === undefined
        ? "none"
        : kick.sourcePatchsetId === `ps-${sourceIndex}`
          ? "active"
          : "other";
    trace.push(
      `kick:source=${kickedSource},occurrences=${kick === undefined ? 0 : kick.askOccurrences.length}`,
    );
    trace.push(`drained:staged=${harness.stagedAskIds().length}`);

    const roundNumber =
      kick === undefined ? 0 : roundNumberForDispatch(harness.records, kick.dispatchId);
    const { successor } = harness.land();
    trace.push(`landed:successor=${successor === `ps-${sourceIndex + 1}` ? "active" : successor}`);

    observations.push({ trace, roundNumber, dispatchId: kick?.dispatchId ?? "" });
  }

  return observations;
}

/** The uniformity claim itself, factored out so the positive control can point the SAME
 *  assertion at a capped machine and watch it fail. */
function assertUniformCycles(observations: readonly CycleObservation[]): void {
  expect(observations.length).toBeGreaterThan(0);
  for (const [index, observation] of observations.entries()) {
    // Ordered, not membership: a cycle that runs the right steps in the wrong order, or
    // grows/loses a step at depth, fails here.
    expect(observation.trace, `cycle ${index + 1} transitions`).toEqual(EXPECTED_CYCLE);
  }
}

describe("the review round loop is unbounded by construction (C14 §8, D7)", () => {
  for (const cycles of [1, 2, 3, 5, 8]) {
    it(`drives ${cycles} dispatch/land cycles with identical transitions`, async () => {
      const observations = await driveRoundLoop(cycles);

      expect(observations).toHaveLength(cycles);
      assertUniformCycles(observations);
      // The ordinal exists — it just never reaches a branch. It counts, in order, and each
      // cycle mints its own dispatch identity off its own source patchset.
      expect(observations.map((o) => o.roundNumber)).toEqual(
        Array.from({ length: cycles }, (_, index) => index + 1),
      );
      expect(new Set(observations.map((o) => o.dispatchId)).size).toBe(cycles);
    });
  }

  it("the eighth round's kick is shaped exactly like the first, on its own successor", async () => {
    const harness = loopHarness();
    for (let cycle = 1; cycle <= 8; cycle += 1) {
      harness.store.append(REVIEW_ID, {
        kind: "stage",
        ask: {
          id: `ask-${cycle}`,
          anchor: `src/x.ts:${cycle}`,
          type: "request-change",
          body: `round ${cycle} ask`,
        },
      });
      await harness.dispatch({ reviewId: REVIEW_ID });
      harness.land();
    }

    // Position, not membership: kick k walked from patchset k, in order, one per cycle.
    expect(harness.kicks.map((kick) => kick.sourcePatchsetId)).toEqual(
      Array.from({ length: 8 }, (_, index) => `ps-${index + 1}`),
    );
    expect(harness.kicks.map((kick) => kick.askOccurrences.map((o) => o.id))).toEqual(
      Array.from({ length: 8 }, (_, index) => [`ask-${index + 1}`]),
    );
    expect(harness.dispatchRound).toHaveBeenCalledTimes(8);
    // Every kick's identity is the documented hash of its own inputs — no ordinal in it.
    for (const [index, kick] of harness.kicks.entries()) {
      expect(kick.dispatchId).toBe(
        sha256Hex(
          JSON.stringify({
            reviewId: REVIEW_ID,
            sourcePatchsetId: `ps-${index + 1}`,
            askOccurrences: kick.askOccurrences,
          }),
        ),
      );
    }
  });

  it("POSITIVE CONTROL: an ordinal cap on dispatch fails the N-round proof", async () => {
    // The defect D7 forbids, injected at the layer it would live on: the dispatch command
    // refuses once two rounds have landed. Every other part of the machine is untouched.
    const capped = await driveRoundLoop(5, (harness) => {
      const real = harness.dispatch;
      return async (input) =>
        harness.records.length >= 2 ? { workOrder: { tasks: [] }, dispatched: false } : real(input);
    });

    expect(() => assertUniformCycles(capped)).toThrow();
    // The cap is invisible until the third cycle — which is exactly why three rounds cannot
    // prove the class and this machine can. Cycles 1 and 2 are indistinguishable from a
    // healthy loop.
    expect(capped[0]?.trace).toEqual(EXPECTED_CYCLE);
    expect(capped[1]?.trace).toEqual(EXPECTED_CYCLE);
    expect(capped[2]?.trace).not.toEqual(EXPECTED_CYCLE);
  });

  it("POSITIVE CONTROL: a round-two special case fails the N-round proof", async () => {
    // A subtler shape than a cap: round two behaves differently. The trace is ordered, so a
    // single cycle that deviates is enough to fail — no cap required.
    const observations = await driveRoundLoop(4, (harness) => {
      const real = harness.dispatch;
      return async (input) => {
        if (harness.records.length === 1) return { workOrder: { tasks: [] }, dispatched: true };
        return real(input);
      };
    });

    expect(() => assertUniformCycles(observations)).toThrow();
    // …and the uncapped machine of the same depth passes it, so the assertion is discriminating
    // rather than simply strict.
    assertUniformCycles(await driveRoundLoop(4));
  });
});

describe("the submit exit terminates the loop — not a count, not a draft (C14 §8.3)", () => {
  it("refuses dispatch on an exhausted queue at depth 0 and depth 5, with the same shape", async () => {
    const harness = loopHarness();

    const atZero = (await harness.dispatch({ reviewId: REVIEW_ID })) as DispatchResult;
    for (let cycle = 1; cycle <= 5; cycle += 1) {
      harness.store.append(REVIEW_ID, {
        kind: "stage",
        ask: {
          id: `ask-${cycle}`,
          anchor: `src/x.ts:${cycle}`,
          type: "request-change",
          body: `round ${cycle} ask`,
        },
      });
      await harness.dispatch({ reviewId: REVIEW_ID });
      harness.land();
    }
    const atFive = (await harness.dispatch({ reviewId: REVIEW_ID })) as DispatchResult;

    // The exhausted-queue refusal is the ONLY refusal the loop has, and it reads identically
    // before the first round and after the fifth. Nothing about depth enters it.
    expect(atZero.dispatched).toBe(false);
    expect(atFive.dispatched).toBe(false);
    expect(atFive.workOrder.tasks).toEqual(atZero.workOrder.tasks);
    expect(atFive.workOrder.composed).toBe(atZero.workOrder.composed);
  });

  it("a sixth round dispatches after five have landed, and offers a seventh", async () => {
    const harness = loopHarness();
    for (let cycle = 1; cycle <= 5; cycle += 1) {
      harness.store.append(REVIEW_ID, {
        kind: "stage",
        ask: {
          id: `ask-${cycle}`,
          anchor: `src/x.ts:${cycle}`,
          type: "request-change",
          body: `round ${cycle} ask`,
        },
      });
      await harness.dispatch({ reviewId: REVIEW_ID });
      harness.land();
    }

    harness.store.append(REVIEW_ID, {
      kind: "stage",
      ask: { id: "ask-6", anchor: "src/x.ts:6", type: "request-change", body: "round 6 ask" },
    });
    const sixth = (await harness.dispatch({ reviewId: REVIEW_ID })) as DispatchResult;
    harness.land();
    harness.store.append(REVIEW_ID, {
      kind: "stage",
      ask: { id: "ask-7", anchor: "src/x.ts:7", type: "request-change", body: "round 7 ask" },
    });
    const seventh = (await harness.dispatch({ reviewId: REVIEW_ID })) as DispatchResult;

    expect(sixth.dispatched).toBe(true);
    expect(seventh.dispatched).toBe(true);
    // The ledger keeps every landed round, in order, each pinned to its own source patchset
    // and successor generation — legible at depth, nothing collapsed or truncated.
    expect(harness.records).toHaveLength(6);
    expect(harness.records.map((record) => record.sourcePatchsetId)).toEqual([
      "ps-1",
      "ps-2",
      "ps-3",
      "ps-4",
      "ps-5",
      "ps-6",
    ]);
    expect(harness.records.map((record) => record.boardGeneration)).toEqual([
      "gen:ps-2",
      "gen:ps-3",
      "gen:ps-4",
      "gen:ps-5",
      "gen:ps-6",
      "gen:ps-7",
    ]);
    expect(new Set(harness.records.map((record) => record.dispatchId)).size).toBe(6);
    // Each row still names its own asks, in the order they were dispatched — the sixth round's
    // account is as complete as the first's, not folded into a summary.
    expect(harness.records.map((record) => record.asksDispatched)).toEqual([
      ["ask-1"],
      ["ask-2"],
      ["ask-3"],
      ["ask-4"],
      ["ask-5"],
      ["ask-6"],
    ]);
  });
});
