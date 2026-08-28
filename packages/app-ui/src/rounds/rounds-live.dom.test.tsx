// @vitest-environment happy-dom
import type { ComposedHandoffBundle, RoundEvent } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { Router } from "wouter";
import { BridgeProvider } from "../data";
import { memoryHistory } from "../routes/history";
import { act, mount, waitFor } from "../test/dom";
import { MemoryBridge } from "../test/memory-bridge";
import { advance, initialRoundState, mergeRoundEvents } from "./round-machine";
import {
  RoundsSourceProvider,
  useLiveRoundsSource,
  useRoundDispatch,
  useRoundState,
  useRoundsUnavailable,
} from "./rounds-data";

// ─────────────────────────────────────────────────────────────────────────────
// C15 3.2 — the LIVE rounds seam. The app tree no longer walks a fixture clock: the
// run state is the `session.roundEvents` catch-up read with the `roundProgress` push
// channel folded into it, reduced through the same `advance` the daemon's events were
// designed for.
//
// The sequence below is the shape the SERVER really emits (`create-server.ts`'s dispatch
// half, then `runRound`'s regeneration half), so the walk asserted here is the walk a
// reviewer watching a real round sees.
// ─────────────────────────────────────────────────────────────────────────────

const REVIEW = "rev-live";

const SERVER_SEQUENCE: readonly RoundEvent[] = [
  { type: "dispatched" },
  {
    type: "prep",
    rows: [
      {
        id: "asks",
        label: "Folded the round's asks into one work order",
        status: "done",
        detail: "2 asks",
      },
    ],
  },
  { type: "worker", rows: [{ id: "turn", label: "Ran the work order", status: "running" }] },
  {
    type: "worker",
    rows: [{ id: "turn", label: "Ran the work order", status: "done", detail: "3 files changed" }],
  },
  { type: "gate" },
  { type: "committed" },
  { type: "report", reportBoardId: "board-report-2" },
  {
    type: "lens",
    lanes: [
      { id: "design", label: "Design", status: "running" },
      { id: "sequence", label: "Sequence", status: "queued" },
    ],
  },
  {
    type: "lens",
    lanes: [
      { id: "design", label: "Design", status: "done", verdict: "reworked" },
      { id: "sequence", label: "Sequence", status: "done", verdict: "carrying-forward" },
    ],
  },
  { type: "composed", generation: "gen:ps-2" },
];

/** The phase each server event lands the machine in — the walk the run route renders. */
function phaseWalk(events: readonly RoundEvent[]): string[] {
  const phases: string[] = [];
  let state = initialRoundState;
  for (const event of events) {
    state = advance(state, event);
    if (phases.at(-1) !== state.phase) phases.push(state.phase);
  }
  return phases;
}

function LiveScope({ children }: { readonly children: React.ReactNode }) {
  return <RoundsSourceProvider value={useLiveRoundsSource()}>{children}</RoundsSourceProvider>;
}

function PhaseProbe({ slug }: { readonly slug: string }) {
  const state = useRoundState(slug);
  const dispatch = useRoundDispatch();
  const unavailable = useRoundsUnavailable(slug);
  return (
    <>
      <span>
        phase:{state.phase}
        {state.phase === "composed" ? `/${state.newGeneration}` : ""}
        {state.phase === "failed" ? `/${state.reason}` : ""}
      </span>
      <span>rounds:{unavailable === undefined ? "readable" : `unavailable/${unavailable}`}</span>
      <button type="button" onClick={() => dispatch?.(slug)}>
        dispatch
      </button>
    </>
  );
}

/** A schema-real `round.dispatch` answer — the UI ignores it, but the write is a real
 *  command round-trip rather than a swallowed rejection. */
const dispatchAnswer = (
  reviewId: string,
): { workOrder: ComposedHandoffBundle; dispatched: boolean } => ({
  workOrder: {
    reviewId,
    patchsetId: "ps-1",
    tasks: [],
    prompt: "",
    digest: "d",
    composed: true,
    traceMap: {},
  },
  dispatched: true,
});

function mountLive(bridge: MemoryBridge, path = `/s/${REVIEW}/run`) {
  const history = memoryHistory(path);
  return mount(
    <BridgeProvider bridge={bridge}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        <LiveScope>
          <PhaseProbe slug={REVIEW} />
        </LiveScope>
      </Router>
    </BridgeProvider>,
  );
}

/** A bridge answering the two live reads; the round log starts wherever `seed` says. */
function liveBridge(seed: readonly RoundEvent[] = []): MemoryBridge {
  return new MemoryBridge({
    "session.roundEvents": () => ({ events: [...seed] }),
    "session.rounds": () => ({ records: [] }),
  });
}

describe("the live rounds seam (C15 3.2)", () => {
  it("walks the real server sequence through the machine's phases", () => {
    expect(phaseWalk(SERVER_SEQUENCE)).toEqual([
      "dispatching",
      "preparing",
      "working",
      "gating",
      "committing",
      "reporting",
      "composing",
      "composed",
    ]);
  });

  it("advances on live pushed events — no fixture clock anywhere in the app tree", async () => {
    const bridge = liveBridge();
    const { getByText } = mountLive(bridge);
    // Honest-absent before any round: an empty log folds to the absent state.
    await waitFor(() => expect(getByText("phase:absent")).toBeTruthy());

    for (const event of SERVER_SEQUENCE) {
      act(() => bridge.emitRoundProgress(REVIEW, event));
    }
    // The composed generation is the one the daemon minted — what the reveal opens.
    await waitFor(() => expect(getByText("phase:composed/gen:ps-2")).toBeTruthy());
  });

  it("a cold mount mid-round folds the catch-up read, not an absent lie", async () => {
    // Everything up to (not including) `composed` already happened before this client
    // existed — a deep-link into a round in flight.
    const bridge = liveBridge(SERVER_SEQUENCE.slice(0, -1));
    const { getByText } = mountLive(bridge);
    await waitFor(() => expect(getByText("phase:composing")).toBeTruthy());

    // ...and the live channel carries it the rest of the way.
    act(() => bridge.emitRoundProgress(REVIEW, { type: "composed", generation: "gen:ps-2" }));
    await waitFor(() => expect(getByText("phase:composed/gen:ps-2")).toBeTruthy());
  });

  it("is honest-absent off a session route (nothing to read, nothing invented)", async () => {
    const bridge = liveBridge(SERVER_SEQUENCE);
    const { getByText } = mountLive(bridge, "/new-chat");
    await waitFor(() => expect(getByText("phase:absent")).toBeTruthy());
  });

  it("a second dispatch resets the run — the prior round's composed does not replay", async () => {
    const bridge = liveBridge(SERVER_SEQUENCE);
    const { getByText } = mountLive(bridge);
    await waitFor(() => expect(getByText("phase:composed/gen:ps-2")).toBeTruthy());
    act(() => bridge.emitRoundProgress(REVIEW, { type: "dispatched" }));
    await waitFor(() => expect(getByText("phase:dispatching")).toBeTruthy());
  });
});

// ── The dispatch INTENT and the daemon's receipt (review finding 7) ────────────
//
// The client used to write a `{type:"dispatched"}` of its own making into the event log
// and swallow the mutation's rejection, so a dispatch the daemon REFUSED still read as a
// round under way. The intent now says only what is true, and the receipt is what
// settles it — confirmed by the daemon's own events, or refuted out loud.
describe("dispatch is an intent until the daemon answers (C15 finding 7)", () => {
  function bridgeWith(dispatchImpl: (reviewId: string) => Promise<unknown>): MemoryBridge {
    return new MemoryBridge({
      "session.roundEvents": () => ({ events: [] }),
      "session.rounds": () => ({ records: [] }),
      "round.dispatch": ((input: { reviewId: string }) => dispatchImpl(input.reviewId)) as never,
    });
  }

  it("shows the reviewer's INTENT while the daemon has said nothing", async () => {
    // The receipt never settles — the window this covers.
    const bridge = bridgeWith(() => new Promise(() => undefined));
    const { getByText } = mountLive(bridge);
    await waitFor(() => expect(getByText("phase:absent")).toBeTruthy());
    act(() => getByText("dispatch").click());
    await waitFor(() => expect(getByText("phase:dispatching")).toBeTruthy());
  });

  it("a REFUSED dispatch reads as failed with the daemon's reason — never a round under way", async () => {
    const bridge = bridgeWith(async () => {
      throw new Error("no work order to dispatch");
    });
    const { getByText } = mountLive(bridge);
    await waitFor(() => expect(getByText("phase:absent")).toBeTruthy());
    act(() => getByText("dispatch").click());
    // THE LIE THIS GUARDS: the round never started, so nothing may claim it did.
    await waitFor(() => expect(getByText("phase:failed/no work order to dispatch")).toBeTruthy());
  });

  it("the daemon's own events take over from the intent once they arrive", async () => {
    const bridge = bridgeWith(async (reviewId) => dispatchAnswer(reviewId));
    const { getByText } = mountLive(bridge);
    await waitFor(() => expect(getByText("phase:absent")).toBeTruthy());
    act(() => getByText("dispatch").click());
    await waitFor(() => expect(getByText("phase:dispatching")).toBeTruthy());
    for (const [seq, event] of SERVER_SEQUENCE.entries()) {
      act(() => bridge.emitRoundProgress(REVIEW, { ...event, seq }));
    }
    await waitFor(() => expect(getByText("phase:composed/gen:ps-2")).toBeTruthy());
  });
});

// ── The catch-up read must not clobber the live push (review finding 7) ────────
describe("the read and the push merge by seq, neither erasing the other", () => {
  it("a terminal event that lands DURING the catch-up read still settles the round", async () => {
    let answer: ((value: { events: RoundEvent[] }) => void) | undefined;
    const bridge = new MemoryBridge({
      // The read hangs until the test releases it — the flight window the race lives in.
      "session.roundEvents": () =>
        new Promise<{ events: RoundEvent[] }>((resolve) => {
          answer = resolve;
        }),
      "session.rounds": () => ({ records: [] }),
    });
    const seeded = SERVER_SEQUENCE.map((event, seq) => ({ ...event, seq }));
    const { getByText } = mountLive(bridge);
    await waitFor(() => expect(answer).toBeTypeOf("function"));

    // The round finishes while the read is still in flight.
    act(() => {
      for (const event of seeded) bridge.emitRoundProgress(REVIEW, event);
    });
    // …and the read's answer, served BEFORE the round composed, lands afterwards.
    await act(async () => {
      answer?.({ events: seeded.slice(0, -1) });
      await Promise.resolve();
    });
    // THE DROP THIS GUARDS: installing the read's answer used to erase the folded stream,
    // so the surface sat at "composing" over a round that had finished.
    await waitFor(() => expect(getByText("phase:composed/gen:ps-2")).toBeTruthy());
  });

  it("mergeRoundEvents drops a finished round's events at the newest dispatched", () => {
    const roundOne: RoundEvent[] = [
      { type: "dispatched", seq: 0 },
      { type: "composed", generation: "gen:ps-1", seq: 1 },
    ];
    const roundTwo: RoundEvent[] = [{ type: "dispatched", seq: 2 }];
    // A LATE terminal frame from round one, delivered after round two started.
    const late: RoundEvent = { type: "failed", reason: "round one died", seq: 1 };
    const merged = mergeRoundEvents([...roundOne, ...roundTwo], [late]);
    expect(merged).toEqual(roundTwo);
    expect(merged.reduce(advance, initialRoundState)).toEqual({ phase: "dispatching" });
  });

  it("mergeRoundEvents dedupes by seq and orders by it, not by arrival", () => {
    const read: RoundEvent[] = [
      { type: "dispatched", seq: 0 },
      { type: "prep", rows: [], seq: 1 },
    ];
    // The push re-delivers seq 1 and adds seq 2 — out of order on the wire.
    const streamed: RoundEvent[] = [
      { type: "worker", rows: [], seq: 2 },
      { type: "prep", rows: [], seq: 1 },
    ];
    expect(mergeRoundEvents(read, streamed).map((e) => e.seq)).toEqual([0, 1, 2]);
  });
});

// ── An older daemon that cannot answer at all (review finding 9) ───────────────
describe("rounds the daemon cannot answer are honestly unavailable, with the reason", () => {
  it("states the daemon's own refusal instead of an empty ledger", async () => {
    // No handlers ⇒ the bridge rejects by name, exactly as an older daemon does.
    const bridge = new MemoryBridge({});
    const { getByText, container } = mountLive(bridge);
    await waitFor(() => expect(container.textContent).toContain("rounds:unavailable/"));
    // The reason is the daemon's, not a Rennet guess about versions.
    expect(container.textContent).toContain("session.round");
    // And it is a STATEMENT, not a gate: nothing is blocked, the round simply is not known.
    expect(getByText(/^phase:absent$/)).toBeTruthy();
  });
});
