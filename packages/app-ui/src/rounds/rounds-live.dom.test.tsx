// @vitest-environment happy-dom
import type { RoundEvent } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { Router } from "wouter";
import { BridgeProvider } from "../data";
import { memoryHistory } from "../routes/history";
import { act, mount, waitFor } from "../test/dom";
import { MemoryBridge } from "../test/memory-bridge";
import { advance, initialRoundState } from "./round-machine";
import { RoundsSourceProvider, useLiveRoundsSource, useRoundState } from "./rounds-data";

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
      { id: "design", label: "Design", status: "done", detail: "reworked" },
      { id: "sequence", label: "Sequence", status: "done", detail: "carrying forward" },
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
  return (
    <span>
      phase:{state.phase}
      {state.phase === "composed" ? `/${state.newGeneration}` : ""}
    </span>
  );
}

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
