// @vitest-environment happy-dom
//
// The hand-off ?view mount (C08 cluster 5, task 5.2/5.3, Reconciliation 1). Load-bearing claims:
// the workspace route gains a `?view=handoff` branch beside `?view=diff` / the board default; the
// exit FAB is mounted across the reading views and toggles to `?view=handoff`; it YIELDS (inert,
// `data-open`) while the hand-off is open; and the board/diff surfaces stay reachable (the route
// still resolves them — the top-bar pill that flips them lives in the frame, unchanged here).
import type { PatchFile, Review } from "@rennet/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Router } from "wouter";
import { ReviewWorkspace } from "../app/review-workspace-route";
import { BridgeProvider } from "../data";
import { memoryHistory } from "../routes/history";
import { useRennetStore } from "../store";
import { cleanup, mount } from "../test/dom";
import { MemoryBridge } from "../test/memory-bridge";

beforeEach(() => useRennetStore.getState().reviewActions.resetReview());
afterEach(cleanup);

const FILE_A: PatchFile = {
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

/** An own-branch review by default (no `postTarget`); pass `over` to make it a teammate PR, etc. */
function review(over: Partial<Review> = {}): Review {
  return {
    id: "r1",
    repositoryRoot: "/repos/atlas",
    patchsets: [{ id: "ps1", files: [FILE_A] }],
    activePatchsetId: "ps1",
    ...over,
  } as unknown as Review;
}

// The hand-off path wires the live `publish.*` exits (C08 cluster 6), so the route now needs a
// bridge. These mount tests exercise the surface shape, not the egress — a bare MemoryBridge (no
// publish handlers) is enough: the own-branch PR compose read simply rejects and the page stays
// on its Changes / "Nothing staged yet." state, which is exactly what these assert.
function mountWorkspace(path: string, r: Review = review()) {
  const history = memoryHistory(path);
  return mount(
    <BridgeProvider bridge={new MemoryBridge({})}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        <ReviewWorkspace review={r} />
      </Router>
    </BridgeProvider>,
  );
}

describe("ReviewWorkspace ?view=handoff mount (C08 task 5.2)", () => {
  it("renders the own-branch rounds surface at ?view=handoff", () => {
    const { getByText } = mountWorkspace("/s/x?view=handoff");
    // Own branch, nothing staged → the rounds lanes' honest empty state.
    expect(getByText("Nothing staged yet.")).toBeTruthy();
  });

  it("renders the teammate-PR Post Review lane at ?view=handoff", () => {
    const { getByText } = mountWorkspace("/s/x?view=handoff", review({ postTarget }));
    expect(getByText("Post Review · acme/orbital#7")).toBeTruthy();
  });

  it("the FAB toggles to ?view=handoff from the board", async () => {
    const r = mountWorkspace("/s/x");
    // The board is showing and the FAB is present and clickable (own branch → "Continue").
    // The landmark is the board element: the `REVIEW · <repo>` eyebrow it used to be is gone
    // (the board opens on the board), and the element is what the surface actually is.
    const board = () => document.querySelector('[data-kind="lens-board-view"]');
    expect(board()).not.toBeNull();
    await r.user.click(r.getByRole("button", { name: /Continue/ }));
    // The hand-off is now open — the board is gone, the rounds surface is shown.
    expect(r.getByText("Nothing staged yet.")).toBeTruthy();
    expect(board()).toBeNull();
  });

  it("the FAB yields (inert, data-open) while the hand-off is open", () => {
    const r = mountWorkspace("/s/x?view=handoff");
    const fab = r.getByRole("button", { name: /Continue/ });
    expect(fab.hasAttribute("data-open")).toBe(true);
    expect(fab.className).toContain("pointer-events-none");
  });

  it("keeps the diff surface reachable (the route still resolves ?view=diff)", () => {
    const { getByText } = mountWorkspace("/s/x?view=diff");
    expect(getByText("packages/core/src/a.ts")).toBeTruthy();
  });

  it("offers no FAB for a retrospective review (law 10)", () => {
    const r = mountWorkspace("/s/x", review({ retrospective: true }));
    expect(r.queryByRole("button", { name: /Continue|Write Review/ })).toBeNull();
  });
});
