// @vitest-environment happy-dom
//
// Post-round delta marks (C09 cluster 7, tasks 7.1 + 7.3; R58, Reconciliation 5). C9 adds
// NO delta mechanism: C5 already draws the per-section gold dot on a `LensSection.delta`
// (`board/section.tsx`) and decays it through the UI-only `viewedDelta` slice
// (`board/viewed-delta.ts`), keyed `boardId::ref` so a successor generation — a NEW board
// id — starts every section unviewed. What cluster 5 already wired is the ARRIVAL: the
// reveal disarms the greeting and returns the surface to `LensBoardView` at the round's
// new generation. So this is a verification test of the reuse, end to end through the real
// `ReviewWorkspace`: land at generation N+1 via the reveal, the changed sections wear their
// delta marks, and each mark decays as its section is viewed. No new production code.
import type { Review } from "@rennet/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Router } from "wouter";
import { BoardSourceProvider } from "../board/board-data";
import { BridgeProvider } from "../data";
import { RoundsSourceProvider } from "../rounds/rounds-data";
import { memoryHistory } from "../routes/history";
import { useRennetStore } from "../store";
import { act, mount } from "../test/dom";
import { fixtureBoardSource } from "../test/fixtures/boards";
import { createTimelineRoundsSource, FIXTURE_ROUND_COMPLETE_TICK } from "../test/fixtures/rounds";
import { MemoryBridge } from "../test/memory-bridge";
import { ReviewWorkspace } from "./review-workspace-route";

const store = () => useRennetStore.getState();

// A stable-id own-branch review — the workspace header reads `repositoryRoot`.
const review = {
  id: "gr-1",
  activePatchsetId: "ps-1",
  repositoryRoot: "/home/dev/rennet",
} as unknown as Review;

// The delta dot is UI-only and per-session; start every case with an empty viewed set.
beforeEach(() => act(() => useRennetStore.setState({ viewedDelta: { viewedDeltaSections: {} } })));
afterEach(() => act(() => store().runActions.resetRun()));

/** Mount the workspace over the composed timeline source + the fixture board source, with
 *  the greeting armed as the run route would arm it before redirecting here. */
function renderWorkspace() {
  act(() => store().runActions.armGreeting(true));
  const timeline = createTimelineRoundsSource({ startTick: FIXTURE_ROUND_COMPLETE_TICK });
  const history = memoryHistory("/s/s-1");
  return mount(
    <BridgeProvider bridge={new MemoryBridge({})}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        <BoardSourceProvider value={fixtureBoardSource}>
          <RoundsSourceProvider value={timeline.source}>
            <ReviewWorkspace review={review} />
          </RoundsSourceProvider>
        </BoardSourceProvider>
      </Router>
    </BridgeProvider>,
  );
}

describe("post-round delta marks — arrival surfaces them, viewing decays them (C09 7.1/7.3)", () => {
  it("landing at generation N+1 via the reveal shows delta marks that decay on view", async () => {
    const r = renderWorkspace();
    // Arrive at the new generation the way the reviewer does: click View the New Boards.
    await r.user.click(r.getByTestId("reveal-new-boards"));
    // The surface is the lens board at the composed round's NEW generation (gen2).
    expect(r.container.querySelector('[data-generation="gen2"]')).not.toBeNull();

    const dots = () => r.container.querySelectorAll('[data-testid="delta-dot"]');
    // gen2's Flagged board (the R44 default lens) carries two changed sections —
    // "Still Open" (reworked) and "Beyond the Asks" (new) — both unviewed on arrival.
    expect(dots()).toHaveLength(2);

    // Finding 6: the marks must carry the RIGHT classification, not merely be present — a
    // presence+decay test stays green if `new`↔`reworked` are swapped. Pin each section's
    // `delta` by id: "Still Open" is `reworked`, "Beyond the Asks" is `new`.
    const section = (id: string) => r.container.querySelector(`[data-section-id="${id}"]`);
    expect(section("g2-open")?.getAttribute("data-delta")).toBe("reworked");
    expect(section("g2-beyond")?.getAttribute("data-delta")).toBe("new");
    // …and the carried-forward frozen section has NEITHER a delta attribute NOR a dot.
    const frozen = section("g2-gen1");
    expect(frozen?.hasAttribute("data-delta")).toBe(false);
    expect(frozen?.querySelector('[data-testid="delta-dot"]')).toBeNull();

    // Viewing a changed section decays ITS mark (the C5 viewed set, keyed boardId::ref).
    await r.user.click(r.getByText("Still Open"));
    expect(dots()).toHaveLength(1);
    await r.user.click(r.getByText("Beyond the Asks"));
    expect(dots()).toHaveLength(0);
  });
});
