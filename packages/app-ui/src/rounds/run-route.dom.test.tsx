// @vitest-environment happy-dom
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryHistory } from "../routes/history";
import { useRennetStore } from "../store";
import { act, fireEvent, mount, waitFor } from "../test/dom";
import {
  createTimelineRoundsSource,
  FIXTURE_ROUND_COMPLETE_TICK,
  type TimelineRoundsSource,
} from "../test/fixtures/rounds";
import {
  advance,
  initialRoundState,
  type LaneRow,
  type RoundEvent,
  type RoundState,
} from "./round-machine";
import { type RoundsSource, RoundsSourceProvider } from "./rounds-data";
import { RunRoute } from "./run-route";

// Cluster 3's run route — the live takeover at `/s/:slug/run`. State comes from the seam
// (the timeline fixture source drives `advance`); NO wall clock advances the rows (a
// `tick()` + rerender is the injected input). Navigation is DERIVED off `runNavigation`
// (autopsy S9): the report phases and a cold absent deep-link redirect to the board, the
// in-flight phases stay. The double-dispatch guard: a cold mid-round mount fires zero
// `dispatch` calls (RunRoute only ever READS state).

// The store is a global singleton — reset the run slice between tests so `greetingArmed`
// assertions do not leak across cases.
afterEach(() => act(() => useRennetStore.getState().runActions.resetRun()));

/** Mount RunRoute under a memory Router + the timeline source, returning both handles. */
function renderRun(opts: { startTick: number; initialPath?: string }): {
  timeline: TimelineRoundsSource;
  history: ReturnType<typeof memoryHistory>;
  rerender: (ui: ReactElement) => void;
  container: HTMLElement;
} {
  const timeline = createTimelineRoundsSource({ startTick: opts.startTick });
  const history = memoryHistory(opts.initialPath ?? "/s/s-1/run");
  const tree = (
    <Router hook={history.hook} searchHook={history.searchHook}>
      <RoundsSourceProvider value={timeline.source}>
        <RunRoute slug="s-1" />
      </RoundsSourceProvider>
    </Router>
  );
  const { container, rerender } = mount(tree);
  return { timeline, history, rerender, container };
}

/** Re-read the mutated timeline clock into the tree (the seam's re-render at cluster 8). */
function pump(handle: ReturnType<typeof renderRun>, tick: number): void {
  handle.timeline.setTick(tick);
  act(() =>
    handle.rerender(
      <Router hook={handle.history.hook} searchHook={handle.history.searchHook}>
        <RoundsSourceProvider value={handle.timeline.source}>
          <RunRoute slug="s-1" />
        </RoundsSourceProvider>
      </Router>,
    ),
  );
}

function renderFixedState(
  state: RoundState,
  overrides: Partial<RoundsSource> = {},
): ReturnType<typeof mount> & { readonly history: ReturnType<typeof memoryHistory> } {
  const source: RoundsSource = {
    roundState: () => state,
    roundRecords: () => [],
    reportBoard: () => undefined,
    ...overrides,
  };
  const history = memoryHistory("/s/s-1/run");
  const handle = mount(
    <Router hook={history.hook} searchHook={history.searchHook}>
      <RoundsSourceProvider value={source}>
        <RunRoute slug="s-1" />
      </RoundsSourceProvider>
    </Router>,
  );
  return { ...handle, history };
}

function failedRoundState(input: {
  readonly reason: string;
  readonly workerStatus: "failed" | "done";
  readonly tail: readonly LaneRow[];
}): RoundState {
  return {
    phase: "failed",
    reason: input.reason,
    operation: {
      operationId: "operation-1",
      revision: 8,
      createdAt: 1_000,
      roundNumber: 1,
      sourceTarget: { kind: "branch", branch: "feat/recovery" },
      askCount: 2,
      gatePlan: { kind: "configured", command: "pnpm check" },
    },
    prep: [
      { id: "worktree", label: "Created detached worktree", status: "done" },
      { id: "asks", label: "Applied the round's asks", status: "done" },
    ],
    worker: [
      input.workerStatus === "failed"
        ? { id: "worker", label: "Round worker", status: "failed", reason: input.reason }
        : { id: "worker", label: "Ran the round worker", status: "done", detail: "1 file" },
    ],
    tail: input.tail,
  };
}

describe("RunRoute — the live round takeover", () => {
  it("renders live worker rows that advance on fixture ticks, with no wall clock", () => {
    // Tick 5: the worker has begun — "Read the refresh path" is running, the next queued.
    const handle = renderRun({ startTick: 5 });
    const read = () => handle.container.querySelector('[data-row="w-read"]');
    const record = () => handle.container.querySelector('[data-row="w-record"]');
    expect(read()?.textContent).toContain("running");
    expect(record()?.textContent).toContain("queued");

    // One tick forward (no timers touched): read settles, record picks up.
    pump(handle, 6);
    expect(read()?.textContent).toContain("github-auth.ts"); // done ⇒ its detail
    expect(record()?.textContent).toContain("running");
  });

  it("a cold mid-round mount reattaches and fires ZERO dispatch (the double-dispatch guard)", () => {
    const handle = renderRun({ startTick: 5 }); // deep-linked into a live round
    // The live state rendered (reattached through the seam)…
    expect(handle.container.querySelector('[data-phase="working"]')).not.toBeNull();
    // …and mounting NEVER dispatched — dispatch is cluster 4's explicit act alone.
    expect(handle.timeline.dispatchCount()).toBe(0);
  });

  it("redirects to the board when the run reaches a report phase (composed)", async () => {
    const handle = renderRun({ startTick: FIXTURE_ROUND_COMPLETE_TICK }); // composed
    // runNavigation(composed) ⇒ replace to the board surface (the greeting lives there).
    await waitFor(() => expect(handle.history.history.at(-1)).toBe("/s/s-1"));
    // Once — the redirect replaced the run entry, it did not loop.
    expect(handle.history.history).toEqual(["/s/s-1"]);
  });

  it("a cold absent deep-link redirects to the session board (no live round)", async () => {
    const handle = renderRun({ startTick: 0 }); // absent
    await waitFor(() => expect(handle.history.history.at(-1)).toBe("/s/s-1"));
    expect(handle.timeline.dispatchCount()).toBe(0); // absent never dispatches either
  });

  it("arms the greeting on verified terminal completion, and only then (§3.2 continuity)", () => {
    // In-flight: the greeting is NOT armed yet.
    renderRun({ startTick: 5 });
    expect(useRennetStore.getState().run.greetingArmed).toBe(false);

    // Reaching composed hands off to the board — the greeting arms for cluster 5.
    act(() => useRennetStore.getState().runActions.resetRun());
    renderRun({ startTick: FIXTURE_ROUND_COMPLETE_TICK });
    expect(useRennetStore.getState().run.greetingArmed).toBe(true);
  });

  it("renders durable report verification receipts and stays on the run route", () => {
    const event: Extract<RoundEvent, { type: "operation" }> = {
      type: "operation",
      snapshot: {
        operationId: "operation-2",
        revision: 9,
        createdAt: 1_000,
        roundNumber: 2,
        sourceTarget: { kind: "branch", branch: "feat/truthful-round" },
        askCount: 3,
        gatePlan: { kind: "configured", command: "pnpm check" },
        state: {
          phase: "report-verifying",
          workspace: { status: "done" },
          worker: { status: "done", fileCount: 4 },
          gate: { status: "passed", durationMs: 2_500, projectCount: 14 },
          commits: { status: "done", count: 2 },
          report: { status: "verifying" },
        },
      },
    };
    const handle = renderFixedState(advance(initialRoundState, event));

    expect(handle.history.history.at(-1)).toBe("/s/s-1/run");
    expect(handle.getByText("Round 2 · feat/truthful-round")).toBeTruthy();
    expect(handle.container.querySelector('[data-row="worktree"]')?.textContent).toContain(
      "feat/truthful-round @ round-2",
    );
    expect(handle.container.querySelector('[data-row="asks"]')?.textContent).toContain("3 asks");
    expect(handle.container.querySelector('[data-row="worker"]')?.textContent).toContain(
      "4 files changed",
    );
    expect(handle.container.querySelector('[data-row="gate"]')?.textContent).toContain(
      "pnpm check · 14 projects green · 2.5 s",
    );
    expect(handle.container.querySelector('[data-row="commit"]')?.textContent).toContain(
      "2 commits",
    );
    expect(handle.container.querySelector('[data-row="report"]')?.textContent).toContain(
      "Verifying the round report",
    );
    expect(useRennetStore.getState().run.greetingArmed).toBe(false);
  });

  it.each([
    {
      stage: "worker",
      state: failedRoundState({
        reason: "worker stopped",
        workerStatus: "failed",
        tail: [],
      }),
    },
    {
      stage: "gate",
      state: failedRoundState({
        reason: "gate failed",
        workerStatus: "done",
        tail: [{ id: "gate", label: "Ran the gate", status: "failed", reason: "gate failed" }],
      }),
    },
    {
      stage: "source landing",
      state: failedRoundState({
        reason: "source landing failed",
        workerStatus: "done",
        tail: [
          { id: "gate", label: "Ran the gate", status: "done" },
          {
            id: "commit",
            label: "Recording round commits",
            status: "failed",
            reason: "source landing failed",
          },
        ],
      }),
    },
    {
      stage: "board regeneration",
      state: failedRoundState({
        reason: "board regeneration failed",
        workerStatus: "done",
        tail: [
          { id: "gate", label: "Ran the gate", status: "done" },
          { id: "commit", label: "Recorded round commits", status: "done" },
          {
            id: "report",
            label: "Drafting the round report",
            status: "failed",
            reason: "board regeneration failed",
          },
        ],
      }),
    },
  ])("offers Retry and Return to Review after a $stage failure", ({ state }) => {
    const retry = vi.fn();
    const handle = renderFixedState(state, { retry });

    fireEvent.click(handle.getByText("Retry"));
    expect(retry).toHaveBeenCalledWith("s-1");
    expect(handle.history.history.at(-1)).toBe("/s/s-1/run");

    fireEvent.click(handle.getByText("Return to Review"));
    expect(handle.history.history.at(-1)).toBe("/s/s-1");
  });
});
