// @vitest-environment happy-dom
//
// Invalidation UX (#576) — the client ASKS whether the review went stale, and SAYS SO when it
// did. `architecture-contracts.md`: "The product does not present a mutated old artifact as
// fresh." Load-bearing claims: the route runs `review.checkFreshness` on mount and again on
// window focus (the reviewer coming back from editing their own tree); a review the daemon
// folded to `status: "invalid"` renders the notice; a `current` one renders nothing at all;
// Regenerate runs `review.regenerate` for this review; a GitHub PR SNAPSHOT is never asked and
// never narrated as stale; and the whole loop closes over the real `review.load` read, so the
// notice cannot silently stop appearing when that read moves. No gate: nothing here blocks a view.
import type { Review } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { Route, Router, Switch } from "wouter";
import { BridgeProvider } from "../data";
import { memoryHistory } from "../routes/history";
import { useSlugResolution } from "../routes/slug";
import { ROUTES } from "../routes/url";
import { act, mount, waitFor } from "../test/dom";
import { MemoryBridge } from "../test/memory-bridge";
import { ReviewWorkspace } from "./review-workspace-route";

const REPO = "/home/dev/widget";

/** A review whose active patchset carries `source` — the provenance the route gates on. */
function reviewAt(
  status: "current" | "invalid",
  source: "local" | "github-local" | "github-rest" = "local",
): Review {
  return {
    id: "rv-1",
    repositoryRoot: REPO,
    status,
    activePatchsetId: "ps-1",
    patchsets: [{ id: "ps-1", source }],
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

  // Review finding A. A PR review is a snapshot against the pull request's pinned OIDs, not a
  // capture of this clone's tree — `review.openPr` says the renderer gates freshness off patchset
  // source. Asking anyway would capture the clone, never match a `github-*` patchset id, commit
  // `ReviewInvalidated`, claim a change that never happened, and let Regenerate REPLACE the PR
  // diff with a local capture. `repositoryDirty` is one global flag, so this is reachable by
  // editing any watched repo and then opening a PR review.
  for (const source of ["github-local", "github-rest"] as const) {
    it(`never asks freshness for a ${source} PR snapshot, and never calls it stale`, async () => {
      // `invalid` is the worst case on purpose: even a review already carrying that status must
      // not be narrated as "the repository changed" when it is not a working-tree capture.
      const { r, asked } = mountWorkspace(reviewAt("invalid", source));

      await act(async () => {
        window.dispatchEvent(new Event("focus"));
        await Promise.resolve();
      });
      expect(asked).toEqual([]);
      expect(r.queryByTestId("review-stale")).toBeNull();
      // The reading surface itself is untouched — this gates the ASK, not the review.
      expect(r.container.textContent).not.toContain("Regenerate");
    });
  }
});

// Review finding C. The three cases above hand `review` in as a prop, so they prove "the ask
// fires" and "an invalid prop renders" — never that the ANSWER reaches the surface. This one
// closes the loop through `useSlugResolution`, the module that owns how a session resolves and
// that declares it will move off `review.load` at B9. If `STALED_BY_FRESHNESS` ever stops naming
// the read that feeds the prop, the banner silently stops appearing — and this test goes red.
describe("invalidation UX — the answer reaches the surface (#576, coupled to routes/slug.ts)", () => {
  it("stales the session read, so the notice renders off the REFRESHED status", async () => {
    let status: "current" | "invalid" = "current";
    let loads = 0;
    const bridge = new MemoryBridge({
      "review.load": () => {
        loads += 1;
        return { review: reviewAt(status), repositoryPresent: true };
      },
      "review.checkFreshness": () => {
        // The daemon's watcher saw the tree move: the fold commits `ReviewInvalidated`.
        status = "invalid";
        return { review: reviewAt(status) };
      },
    });
    const history = memoryHistory("/s/rv-1");
    const r = mount(
      <BridgeProvider bridge={bridge}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          <Switch>
            <Route path={ROUTES.session}>{(p) => <SessionUnderTest slug={p.slug ?? ""} />}</Route>
          </Switch>
        </Router>
      </BridgeProvider>,
    );

    // The window opened on a review that was current; the notice only arrives because the
    // freshness answer invalidated the session read and the refetch carried the new status.
    const notice = await waitFor(() => r.getByTestId("review-stale"));
    expect(notice.textContent).toContain("The repository changed since this review was captured");
    expect(loads).toBeGreaterThan(1);
  });
});

/** What `routes/app.tsx`'s SessionScreen does, minus the not-found/error surfaces. */
function SessionUnderTest({ slug }: { slug: string }) {
  const resolution = useSlugResolution(slug);
  if (resolution.status !== "review") return <p>Opening…</p>;
  return <ReviewWorkspace review={resolution.review} />;
}
