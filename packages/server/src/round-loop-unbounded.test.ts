import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AskLogStore } from "@rennet/adapters";
import {
  type ForgePrSubmission,
  type ForgePrSubmissionOutcome,
  type ForgePrSubmissionTarget,
  mechanicalComposition,
} from "@rennet/core";
import type {
  AskOccurrence,
  AskProjection,
  ComposedHandoffBundle,
  DispositionType,
  Patchset,
  Review,
  RoundRecord,
} from "@rennet/protocol";
import { sha256Hex } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import { createDispatchRuntime, type DispatchDeps } from "./dispatch";
import { publishHandlers } from "./dispatch/publish";
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
// WHO WRITES THE TRACE. Every proved step is emitted from INSIDE the production path, by the
// dependency callbacks `round.dispatch` itself invokes — the ledger read, the composer, the
// worker kick, the post-drain projection broadcast — plus the handler's own resolved return
// value, appended at the instant its promise settles. So the ORDER is the machine's, not the
// test's narration: a production path that kicked before composing, or drained before
// kicking, produces a different sequence here.
//
// Two steps per cycle are NOT production's and are labelled `fixture:` — a reviewer staging
// an ask, and `land()`, which fabricates what a real coding agent does off-process (commits,
// the round record, the successor patchset). They are kept in the trace so a cycle reads
// end to end, and EXCLUDED from the ordered assertion, which therefore covers exactly what
// production emits. The count of excluded steps is itself asserted, so a production step
// cannot be quietly relabelled as fixture-authored.
//
// The trace is deliberately ordinal-free: cycle-specific ids (patchset, dispatch identity,
// ask id) are normalised out, so two cycles differ in the trace ONLY if the machine
// behaved differently. The ordinal itself is carried alongside as DATA (`roundNumber`,
// which only ever counts) and asserted to grow without ever reaching the transitions.
//
// The positive controls at the foot introduce the defect this section exists to forbid — a
// dispatch capped by round ordinal, and a round-two special case — by substituting a capped
// handler at the test's dispatch seam, and assert the uniformity check FAILS on each.
// Without them, the assertion above is a green bar with nothing behind it.

const REVIEW_ID = "review-1";
const REPO_ROOT = "/repo";
const HEAD_REF = "feat/x";
const BASE_REF = "main";
const TARGET = {
  repo: { forge: "github", owner: "acme", name: "widget" },
} satisfies ForgePrSubmissionTarget;
const DESTINATION = { remoteName: "origin", target: TARGET };

/** Prefix marking a trace step the FIXTURE authored rather than production. */
const FIXTURE = "fixture:";

interface DispatchResult {
  readonly workOrder: ComposedHandoffBundle;
  readonly dispatched: boolean;
}

type DispatchHandler = (input: { readonly reviewId: string }) => Promise<unknown>;

interface ComposedPr {
  readonly status: "pr";
  readonly submission: ForgePrSubmission;
  readonly target: ForgePrSubmissionTarget;
  readonly payload: string;
  readonly compositionId: string;
}
type ComposeResult = ComposedPr | { readonly status: "unavailable"; readonly reason: string };

function patchsetAt(index: number): Patchset {
  return {
    id: `ps-${index}`,
    createdAt: "",
    truncated: false,
    files: [],
    repository: { root: REPO_ROOT, headRef: HEAD_REF, baseRef: BASE_REF },
  } as unknown as Patchset;
}

/** The loop's driver: one mutable own-branch review whose active patchset advances as each
 *  round lands, over a real durable ask log and the real `round.dispatch` + `publish.*`
 *  handlers. Every dependency callback the handlers invoke appends to `trace`. */
function loopHarness() {
  const trace: string[] = [];
  const patchsets: Patchset[] = [patchsetAt(1)];
  const review = {
    id: REVIEW_ID,
    repositoryRoot: REPO_ROOT,
    activePatchsetId: "ps-1",
    patchsets,
    dispositions: [],
    status: "current",
    retrospective: false,
  } as unknown as Review & { activePatchsetId: string };
  const records: RoundRecord[] = [];
  const store = new AskLogStore(mkdtempSync(join(tmpdir(), "rennet-round-loop-")));
  const kicks: {
    readonly sourcePatchsetId: string;
    readonly dispatchId: string;
    readonly askOccurrences: readonly AskOccurrence[];
  }[] = [];
  const submissions: { readonly headRef: string; readonly submission: ForgePrSubmission }[] = [];
  const dispatchRound = vi.fn<NonNullable<DispatchDeps["dispatchRound"]>>(async (input) => {
    kicks.push({
      sourcePatchsetId: input.sourcePatchsetId,
      dispatchId: input.dispatchId,
      askOccurrences: input.askOccurrences,
    });
    // Emitted BY the kick: the source is read against whatever patchset is active at the
    // moment production called, so an ordinal never enters the normalisation.
    const source =
      input.sourcePatchsetId === review.activePatchsetId ? "active" : input.sourcePatchsetId;
    trace.push(`kick:source=${source},occurrences=${input.askOccurrences.length}`);
    return undefined;
  });
  // The optional model composer, wired to the mechanical floor. Its call site is inside the
  // dispatch run, so its position in the trace is production's.
  const composeBundle: NonNullable<DispatchDeps["composeBundle"]> = async ({ bundle }) => {
    const workOrder = mechanicalComposition(bundle);
    trace.push(`compose:tasks=${workOrder.tasks.length}`);
    return workOrder;
  };
  // The forge port production already defines for the push + PR open — stubbed here so the
  // gate makes no live call; nothing else about the submit path is substituted.
  const submitPullRequest: NonNullable<DispatchDeps["submitPullRequest"]> = async ({
    headRef,
    submission,
  }) => {
    const reused = submissions.some((entry) => entry.headRef === headRef);
    submissions.push({ headRef, submission });
    return { url: `https://pr/${headRef}`, number: 42, reused };
  };
  const rt = createDispatchRuntime({
    askLog: store,
    allowedRoots: new Set([REPO_ROOT]),
    service: { reviewById: (id: string) => (id === REVIEW_ID ? review : undefined) },
    dispatchRound,
    roundRecordsForReview: () => {
      trace.push("ledger-read");
      return records;
    },
    composeBundle,
    // Production broadcasts the projection only after the durable ask drain commits.
    broadcastAskProjection: (_reviewId: string, projection: AskProjection) => {
      trace.push(`drained:staged=${Object.keys(projection.stagedAsks).length}`);
    },
    raiseAttention: () => "att-1",
    resolvePullRequestDestination: () => Promise.resolve(DESTINATION),
    submitPullRequest,
  } as unknown as DispatchDeps);
  const publish = publishHandlers(rt);

  /** FIXTURE-AUTHORED: a reviewer staging one ask. */
  const stageAsk = (index: number, type: DispositionType = "request-change") => {
    store.append(REVIEW_ID, {
      kind: "stage",
      ask: { id: `ask-${index}`, anchor: `src/x.ts:${index}`, type, body: `round ${index} ask` },
    });
    trace.push(`${FIXTURE}stage-ask`);
  };

  /** FIXTURE-AUTHORED, and unavoidably so: landing is EXTERNAL by design — a real coding
   *  agent commits, the runtime records the round and mints the successor patchset in another
   *  process. Reproducing it here would be reimplementing the runtime, so it is fabricated,
   *  labelled, and excluded from the ordered proof. */
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
    trace.push(`${FIXTURE}land`);
    return { generation, successor };
  };

  return {
    store,
    review,
    records,
    kicks,
    trace,
    submissions,
    land,
    stageAsk,
    dispatchRound,
    dispatch: roundHandlers(rt)["round.dispatch"] as DispatchHandler,
    compose: () =>
      publish["publish.compose"]({
        commandId: randomUUID(),
        reviewId: REVIEW_ID,
        mode: "pr",
      }) as Promise<ComposeResult>,
    submit: (composed: ComposedPr) =>
      publish["publish.submitPr"]({
        commandId: randomUUID(),
        reviewId: REVIEW_ID,
        target: composed.target,
        submission: composed.submission,
        payload: composed.payload,
        compositionId: composed.compositionId,
      }) as Promise<ForgePrSubmissionOutcome>,
    stagedAskIds: () => Object.keys(store.readProjection(REVIEW_ID).stagedAsks),
  };
}

/** One cycle's PRODUCTION-EMITTED transitions, with every cycle-specific identity normalised
 *  away. Anything ordinal-dependent in the machine shows up here as a differing sequence. */
const EXPECTED_CYCLE: readonly string[] = [
  // The refusing dispatch on an exhausted queue: production reads the ledger, finds nothing
  // addressed, and answers — it never reaches the composer or the worker.
  "ledger-read",
  "return:dispatched=false,tasks=0",
  // The dispatching one, in production's own order: ledger, compose, kick, drain, answer.
  "ledger-read",
  "compose:tasks=1",
  "kick:source=active,occurrences=1",
  "drained:staged=0",
  "return:dispatched=true,tasks=1",
];

/** The two steps the fixture authors each cycle, in order. Asserted, so production steps
 *  cannot migrate into the excluded set unnoticed. */
const FIXTURE_STEPS: readonly string[] = [`${FIXTURE}stage-ask`, `${FIXTURE}land`];

interface CycleObservation {
  /** The full interleaved cycle — production steps plus the `fixture:` ones. */
  readonly trace: readonly string[];
  readonly roundNumber: number;
  readonly dispatchId: string;
}

const productionSteps = (trace: readonly string[]): readonly string[] =>
  trace.filter((step) => !step.startsWith(FIXTURE));
const fixtureSteps = (trace: readonly string[]): readonly string[] =>
  trace.filter((step) => step.startsWith(FIXTURE));

/** Drive the real handler through `cycles` complete dispatch/land cycles, slicing each
 *  cycle's transitions off the harness trace. `dispatchFor` lets the positive control
 *  substitute a capped handler at exactly the layer a cap would live. */
async function driveRoundLoop(
  cycles: number,
  dispatchFor: (harness: ReturnType<typeof loopHarness>) => DispatchHandler = (h) => h.dispatch,
): Promise<readonly CycleObservation[]> {
  const harness = loopHarness();
  const dispatch = dispatchFor(harness);
  const observations: CycleObservation[] = [];

  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    const from = harness.trace.length;

    // An exhausted ask queue refuses — and it must read the same at depth 1 and depth N.
    const idle = (await dispatch({ reviewId: REVIEW_ID })) as DispatchResult;
    // The handler's own answer, appended where its promise settled: after everything the
    // call did, before anything the next step does.
    harness.trace.push(`return:dispatched=${idle.dispatched},tasks=${idle.workOrder.tasks.length}`);

    harness.stageAsk(cycle);

    const result = (await dispatch({ reviewId: REVIEW_ID })) as DispatchResult;
    harness.trace.push(
      `return:dispatched=${result.dispatched},tasks=${result.workOrder.tasks.length}`,
    );

    const kick = harness.kicks.at(-1);
    const roundNumber =
      kick === undefined ? 0 : roundNumberForDispatch(harness.records, kick.dispatchId);
    harness.land();

    observations.push({
      trace: harness.trace.slice(from),
      roundNumber,
      dispatchId: kick?.dispatchId ?? "",
    });
  }

  return observations;
}

/** The uniformity claim itself, factored out so the positive control can point the SAME
 *  assertion at a capped machine and watch it fail. */
function assertUniformCycles(observations: readonly CycleObservation[]): void {
  expect(observations.length).toBeGreaterThan(0);
  // Guard the guard: the proved sequence may contain nothing the fixture authored.
  expect(EXPECTED_CYCLE.filter((step) => step.startsWith(FIXTURE))).toEqual([]);
  for (const [index, observation] of observations.entries()) {
    // Ordered, not membership: a cycle that runs the right steps in the wrong order, or
    // grows/loses a step at depth, fails here.
    expect(productionSteps(observation.trace), `cycle ${index + 1} production transitions`).toEqual(
      EXPECTED_CYCLE,
    );
  }
}

describe("the review round loop is unbounded by construction (C14 §8, D7)", () => {
  for (const cycles of [1, 2, 3, 5, 8]) {
    it(`drives ${cycles} dispatch/land cycles with identical transitions`, async () => {
      const observations = await driveRoundLoop(cycles);

      expect(observations).toHaveLength(cycles);
      assertUniformCycles(observations);
      // The excluded set is exactly the two fixture-authored steps, every cycle — a
      // production step relabelled `fixture:` (and so dropped from the proof) fails here.
      expect(observations.map((o) => fixtureSteps(o.trace))).toEqual(
        Array.from({ length: cycles }, () => FIXTURE_STEPS),
      );
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
      harness.stageAsk(cycle);
      await harness.dispatch({ reviewId: REVIEW_ID });
      harness.land();
    }

    // Position, not membership: kick k walked from patchset k, in order, one per cycle. This
    // is also where the fabricated landing is checked against production: each kick's source
    // is the successor the previous cycle minted, read back off production's own call.
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
    // The defect D7 forbids, injected at the test's dispatch seam (the handler the driver
    // calls): the dispatch command refuses once two rounds have landed. Every other part of
    // the machine is untouched, so the trace still records whatever production does run.
    const capped = await driveRoundLoop(5, (harness) => {
      const real = harness.dispatch;
      return async (input) =>
        harness.records.length >= 2 ? { workOrder: { tasks: [] }, dispatched: false } : real(input);
    });

    expect(() => assertUniformCycles(capped)).toThrow();
    // The cap is invisible until the third cycle — which is exactly why three rounds cannot
    // prove the class and this machine can. Cycles 1 and 2 are indistinguishable from a
    // healthy loop.
    expect(productionSteps(capped[0]?.trace ?? [])).toEqual(EXPECTED_CYCLE);
    expect(productionSteps(capped[1]?.trace ?? [])).toEqual(EXPECTED_CYCLE);
    expect(productionSteps(capped[2]?.trace ?? [])).not.toEqual(EXPECTED_CYCLE);
    // The capped cycle emitted NO production step at all beyond the two refusals it faked —
    // no ledger read, no compose, no kick. The exclusion did not hide the defect.
    expect(productionSteps(capped[2]?.trace ?? [])).toEqual([
      "return:dispatched=false,tasks=0",
      "return:dispatched=false,tasks=0",
    ]);
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

describe("the round loop's refusals do not change with depth (C14 §8.3)", () => {
  it("refuses dispatch on an exhausted queue at depth 0 and depth 5, with the same shape", async () => {
    const harness = loopHarness();

    const atZero = (await harness.dispatch({ reviewId: REVIEW_ID })) as DispatchResult;
    for (let cycle = 1; cycle <= 5; cycle += 1) {
      harness.stageAsk(cycle);
      await harness.dispatch({ reviewId: REVIEW_ID });
      harness.land();
    }
    const atFive = (await harness.dispatch({ reviewId: REVIEW_ID })) as DispatchResult;

    // The exhausted-queue refusal reads identically before the first round and after the
    // fifth. Nothing about depth enters it.
    expect(atZero.dispatched).toBe(false);
    expect(atFive.dispatched).toBe(false);
    expect(atFive.workOrder.tasks).toEqual(atZero.workOrder.tasks);
    expect(atFive.workOrder.composed).toBe(atZero.workOrder.composed);
  });

  it("refuses a queue of only non-coding asks the same way at depth 0 and depth 3", async () => {
    // The loop's OTHER refusal, and the reason "exhausted queue" is not the whole story: a
    // question is answered in conversation and an approval asks the worker to leave the code
    // alone, so a queue holding only those composes no task and dispatches nothing — with the
    // asks still staged, not consumed.
    const harness = loopHarness();
    harness.stageAsk(100, "question");
    harness.stageAsk(101, "approve");
    const atZero = (await harness.dispatch({ reviewId: REVIEW_ID })) as DispatchResult;

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      harness.stageAsk(cycle);
      await harness.dispatch({ reviewId: REVIEW_ID });
      harness.land();
    }
    const atThree = (await harness.dispatch({ reviewId: REVIEW_ID })) as DispatchResult;

    expect(atZero.dispatched).toBe(false);
    expect(atThree.dispatched).toBe(false);
    expect(atThree.workOrder.tasks).toEqual(atZero.workOrder.tasks);
    // Non-empty queue throughout: the refusal is about what the asks ARE, not how many.
    expect(harness.stagedAskIds().sort()).toEqual(["ask-100", "ask-101"]);
    // …and the same queue with ONE coding ask added dispatches, so the refusal above is a
    // fact about the ask types rather than a stuck loop.
    harness.stageAsk(4);
    const withCodingAsk = (await harness.dispatch({ reviewId: REVIEW_ID })) as DispatchResult;
    expect(withCodingAsk.dispatched).toBe(true);
  });

  it("a sixth round dispatches after five have landed, and offers a seventh", async () => {
    const harness = loopHarness();
    for (let cycle = 1; cycle <= 5; cycle += 1) {
      harness.stageAsk(cycle);
      await harness.dispatch({ reviewId: REVIEW_ID });
      harness.land();
    }

    harness.stageAsk(6);
    const sixth = (await harness.dispatch({ reviewId: REVIEW_ID })) as DispatchResult;
    harness.land();
    harness.stageAsk(7);
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

// ─────────────────────────────────────────────────────────────────────────────
// The submit exit (spec `review-round-loop:40`, C14 §8.3). The same exit must be reachable
// at zero rounds and on the Nth successor, and holding a composed draft must not lock the
// loop. This drives the REAL `publish.compose` + `publish.submitPr` handlers over the same
// runtime the rounds ran on — the durable ask log they read is the one the rounds drained,
// and the patchset they compose from is the one N landings advanced. Only the forge itself
// is stubbed, at `submitPullRequest` / `resolvePullRequestDestination` — the ports the
// production code already defines for it.
// ─────────────────────────────────────────────────────────────────────────────

describe("the submit exit is the same exit at zero rounds and on the Nth successor", () => {
  it("composes and submits identical bytes at depth 0 and after five production cycles", async () => {
    const atZero = loopHarness();
    const composedAtZero = (await atZero.compose()) as ComposedPr;
    expect(composedAtZero.status).toBe("pr");
    const openedAtZero = await atZero.submit(composedAtZero);
    expect(openedAtZero.reused).toBe(false);
    expect(atZero.submissions).toEqual([
      { headRef: HEAD_REF, submission: composedAtZero.submission },
    ]);

    const atFive = loopHarness();
    for (let cycle = 1; cycle <= 5; cycle += 1) {
      atFive.stageAsk(cycle);
      const dispatched = (await atFive.dispatch({ reviewId: REVIEW_ID })) as DispatchResult;
      expect(dispatched.dispatched).toBe(true);
      atFive.land();
    }
    expect(atFive.records).toHaveLength(5);
    expect(atFive.review.activePatchsetId).toBe("ps-6");

    const composedAtFive = (await atFive.compose()) as ComposedPr;
    expect(composedAtFive.status).toBe("pr");
    // Byte for byte the same submission — re-derived by production from the review at depth
    // five, not carried over from the depth-zero compose.
    expect(composedAtFive.submission).toEqual(composedAtZero.submission);
    expect(composedAtFive.payload).toBe(composedAtZero.payload);
    // …while the integrity binding is NOT reused: it is bound to the patchset five rounds
    // minted, so a stale preview from an earlier successor could not be submitted here.
    expect(composedAtFive.compositionId).not.toBe(composedAtZero.compositionId);

    const openedAtFive = await atFive.submit(composedAtFive);
    expect(openedAtFive.reused).toBe(false);
    expect(atFive.submissions).toEqual([
      { headRef: HEAD_REF, submission: composedAtZero.submission },
    ]);
  });

  it("a composed draft does not lock the loop: a staged ask still dispatches, then the same draft submits", async () => {
    const harness = loopHarness();
    const draft = (await harness.compose()) as ComposedPr;
    expect(draft.status).toBe("pr");

    // Draft in hand, one more ask arrives. The exit honestly withdraws (the draft is held,
    // not spent) and the submit REFUSES rather than skipping the round …
    harness.stageAsk(1);
    const whileStaged = await harness.compose();
    expect(whileStaged.status).toBe("unavailable");
    await expect(harness.submit(draft)).rejects.toThrow(/ask remains/);
    expect(harness.submissions).toEqual([]);

    // … and the loop is still live underneath it: the round dispatches and lands normally.
    const dispatched = (await harness.dispatch({ reviewId: REVIEW_ID })) as DispatchResult;
    expect(dispatched.dispatched).toBe(true);
    harness.land();

    // Draining the ask returns the SAME submission on the new successor, and it submits.
    const again = (await harness.compose()) as ComposedPr;
    expect(again.status).toBe("pr");
    expect(again.submission).toEqual(draft.submission);
    expect(again.payload).toBe(draft.payload);
    const opened = await harness.submit(again);
    expect(opened.reused).toBe(false);
    expect(harness.submissions).toEqual([{ headRef: HEAD_REF, submission: draft.submission }]);
  });
});
