// @vitest-environment happy-dom
//
// Invalidation UX (#576) — the client ASKS whether the review went stale, and SAYS SO when it
// did. `architecture-contracts.md`: "The product does not present a mutated old artifact as
// fresh." Load-bearing claims: the route runs `review.checkFreshness` on mount and again on
// window focus (the reviewer coming back from editing their own tree); a review the daemon
// folded to `status: "invalid"` renders the notice; a `current` one renders nothing at all;
// and Regenerate runs `review.regenerate` for this review. No gate: nothing here blocks a view.
import type { Review } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { Route, Router, Switch } from "wouter";
import { BridgeProvider } from "../data";
import { memoryHistory } from "../routes/history";
import { ROUTES } from "../routes/url";
import { act, mount, waitFor } from "../test/dom";
import { MemoryBridge } from "../test/memory-bridge";
import { ReviewWorkspace } from "./review-workspace-route";

const REPO = "/home/dev/widget";

function reviewAt(status: "current" | "invalid"): Review {
  return {
    id: "rv-1",
    repositoryRoot: REPO,
    status,
    activePatchsetId: "ps-1",
  } as unknown as Review;
}

/** Mount the workspace over a bridge that records every freshness/regenerate call it is asked. */
function mountWorkspace(review: Review) {
  const asked: unknown[] = [];
  const regenerated: unknown[] = [];
  const bridge = new MemoryBridge({
    "review.checkFreshness": (input) => {
      asked.push(input);
      return { review };
    },
    "review.regenerate": (input) => {
      regenerated.push(input);
      return { review };
    },
  });
  const history = memoryHistory("/s/rv-1");
  const r = mount(
    <BridgeProvider bridge={bridge}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        <Switch>
          <Route path={ROUTES.session}>{() => <ReviewWorkspace review={review} />}</Route>
        </Switch>
      </Router>
    </BridgeProvider>,
  );
  return { r, asked, regenerated };
}

describe("invalidation UX (#576)", () => {
  it("asks the daemon whether this review went stale, on mount and on every window focus", async () => {
    const { asked } = mountWorkspace(reviewAt("current"));

    await waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0]).toMatchObject({ reviewId: "rv-1", repoPath: REPO });

    // Coming back to the window is exactly when the reviewer has been editing their own tree.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    await waitFor(() => expect(asked).toHaveLength(2));
  });

  it("says so when the review is stale, and regenerates on the click", async () => {
    const { r, regenerated } = mountWorkspace(reviewAt("invalid"));

    const notice = await waitFor(() => r.getByTestId("review-stale"));
    expect(notice.textContent).toContain("The repository changed since this review was captured");

    await r.user.click(r.getByRole("button", { name: "Regenerate" }));
    await waitFor(() => expect(regenerated).toHaveLength(1));
    expect(regenerated[0]).toMatchObject({ reviewId: "rv-1", repoPath: REPO });
  });

  it("says nothing at all about a current review — the notice is a fact, not decoration", async () => {
    const { r, asked } = mountWorkspace(reviewAt("current"));
    await waitFor(() => expect(asked).toHaveLength(1));
    expect(r.queryByTestId("review-stale")).toBeNull();
  });
});
