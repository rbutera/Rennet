// @vitest-environment happy-dom
//
// Review-identity isolation (C08 fix loop, finding 2 — critical). The `review` slice is a store
// SINGLETON; the reviewer's ephemeral acts (staged asks, retired ledger, inline edits, the verdict
// override) belong to ONE review and must not survive a switch to another. The spike's leak (C05's
// boardId lesson, restated): A's asks/override contaminate B, and A's override becomes B's submitted
// verdict. `ReviewWorkspace` resets the slice when `review.id` changes — so this proves the switch
// isolates WITHOUT any test calling `resetReview()` (the reset is the surface's job, not the test's).
import type { PatchFile, Review } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Router } from "wouter";
import { ReviewWorkspace } from "../app/review-workspace-route";
import { BridgeProvider } from "../data";
import { memoryHistory } from "../routes/history";
import { useRennetStore } from "../store";
import { act, cleanup, mount } from "../test/dom";
import { MemoryBridge } from "../test/memory-bridge";

// Start each test from a clean slice; the switch under test does its own reset, un-aided.
afterEach(() => {
  cleanup();
  useRennetStore.getState().reviewActions.resetReview();
});

const FILE: PatchFile = {
  path: "packages/core/src/a.ts",
  status: "modified",
  additions: 1,
  deletions: 0,
  binary: false,
  patch: ["@@ -1,1 +1,1 @@", "-const y = 2", "+const y = 3"].join("\n"),
};

const postTarget = {
  repo: { forge: "github", owner: "acme", name: "orbital" },
  number: 7,
  forgeRef: "PR_x",
  headOid: "abc",
};

// Both reviews are teammate-PR (they carry a postTarget) so the FAB label stays "Write Review" — the
// only thing that moves between A and B is the exit COUNT, isolating the leak from a mode change.
function review(id: string): Review {
  return {
    id,
    repositoryRoot: "/repos/atlas",
    patchsets: [{ id: "ps1", files: [FILE] }],
    activePatchsetId: "ps1",
    postTarget: { ...postTarget, number: id === "A" ? 7 : 8 },
  } as unknown as Review;
}

function stage(anchor: string) {
  act(() =>
    useRennetStore.getState().reviewActions.stageAsk({
      id: anchor,
      anchor,
      type: "request-change",
      body: `ask ${anchor}`,
    }),
  );
}

/** These reviews drafted no boards — the board reads answer honest-missing, and the
 *  subject here is the FAB + the review slice, not the board. */
const noBoardsBridge = () => new MemoryBridge({ "board.read": () => ({ board: null }) });

describe("review-identity isolation (C08 finding 2)", () => {
  it("switching review.id resets the slice — A's asks and verdict override never reach B", async () => {
    const history = memoryHistory("/s/x"); // board view: the FAB is visible
    const view = mount(
      <BridgeProvider bridge={noBoardsBridge()}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          <ReviewWorkspace review={review("A")} />
        </Router>
      </BridgeProvider>,
    );

    // Review A: stage two asks and override the verdict — the reviewer's acts on THIS review.
    stage("src/a.ts:5");
    stage("src/a.ts:9");
    act(() => useRennetStore.getState().reviewActions.setVerdictOverride("APPROVE"));

    // The FAB pip (its accessible name carries the count, R50) reflects A's two asks.
    expect(view.getByRole("button", { name: "Write Review, 2 staged" })).toBeTruthy();
    expect(useRennetStore.getState().review.verdictOverride).toBe("APPROVE");

    // Switch to review B — a different identity. No test calls resetReview(): the surface must.
    view.rerender(
      <BridgeProvider bridge={noBoardsBridge()}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          <ReviewWorkspace review={review("B")} />
        </Router>
      </BridgeProvider>,
    );

    // B starts clean: no pip on the FAB (count 0), and the slice is empty — A's override is gone,
    // so it can never become B's submitted verdict.
    expect(await view.findByRole("button", { name: "Write Review" })).toBeTruthy();
    expect(view.queryByRole("button", { name: /staged/ })).toBeNull();
    const slice = useRennetStore.getState().review;
    expect(Object.keys(slice.stagedAsks)).toHaveLength(0);
    expect(slice.verdictOverride).toBeNull();
  });

  it("does NOT reset on first mount — a seed-then-mount survives (fixtures/tests rely on it)", () => {
    // Seed the slice, THEN mount the review that owns it. The reset fires only on an id CHANGE, so
    // the initial mount must preserve the seeded acts (the exits pending-mark test seeds like this).
    stage("src/a.ts:5");
    const history = memoryHistory("/s/x");
    const view = mount(
      <BridgeProvider bridge={noBoardsBridge()}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          <ReviewWorkspace review={review("A")} />
        </Router>
      </BridgeProvider>,
    );
    expect(view.getByRole("button", { name: "Write Review, 1 staged" })).toBeTruthy();
    expect(Object.keys(useRennetStore.getState().review.stagedAsks)).toHaveLength(1);
  });
});
