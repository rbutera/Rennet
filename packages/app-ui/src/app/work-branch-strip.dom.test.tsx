// @vitest-environment happy-dom
//
// The work-branch strip in the review workspace (workspace-settings D4, review finding W6).
//
// TWO claims, and they are both about the ROUTE rather than about the note.
//
// 1. THE STRIP IS MOUNTED ON THE WORKSPACE, not on the round greeting. The gap between
//    `feat/x` and `rennet/feat/x` opens the moment a round commits and stays open until the
//    reviewer lands or pulls; mounting the sentence on a greeting made it visible only while
//    a fresh report happened to be on screen, so the reviewer who reloaded, or opened the
//    diff, was told nothing.
//
// 2. THE REVIEWED BRANCH COMES FROM THE ACTIVE PATCHSET. That derivation is the one that
//    took 37 suites down when it was written unguarded (4991d787), and it is also the one
//    that decides whether the strip appears at all — a session's claim can name a branch a
//    workspace project's OTHER repository is on, so the claim cannot answer this.
//
// The second is tested by DISCRIMINATION, not by presence: each case carries two patchsets
// whose head refs are swapped, so a derivation that read `patchsets[0]` instead of the
// active one would flip both verdicts rather than passing one of them by luck.
import type { Review } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { Route, Router, Switch } from "wouter";
import { BridgeProvider } from "../data";
import { memoryHistory } from "../routes/history";
import { ROUTES } from "../routes/url";
import { mount, waitFor } from "../test/dom";
import { MemoryBridge } from "../test/memory-bridge";
import { ReviewWorkspace } from "./review-workspace-route";

const REPO = "/home/dev/widget";
const SLUG = "s-1";

/** A review whose ACTIVE patchset is the second one — so a first-element read is wrong. */
function reviewOn(refs: { first: string; active: string }): Review {
  return {
    id: "rv-1",
    repositoryRoot: REPO,
    status: "current",
    activePatchsetId: "ps-active",
    patchsets: [
      { id: "ps-first", source: "local-branch", repository: { headRef: refs.first } },
      { id: "ps-active", source: "local-branch", repository: { headRef: refs.active } },
    ],
  } as unknown as Review;
}

/**
 * Mount the workspace over a session bound on a sibling. `session.workBranchState` is the
 * note's own read and is answered as the daemon would; the route's job is only to decide
 * whether the note is mounted, which is what these cases discriminate.
 */
function mountWorkspace(review: Review, session: Record<string, unknown>) {
  const asked: unknown[] = [];
  const bridge = new MemoryBridge({
    "session.list": () => ({ sessions: [session] }) as never,
    "session.workBranchState": (input) => {
      asked.push(input);
      return {
        branch: "feat/x",
        workBranch: "rennet/feat/x",
        ahead: 1,
        pushed: false,
        landed: false,
      };
    },
  });
  const history = memoryHistory(`/s/${SLUG}`);
  const r = mount(
    <BridgeProvider bridge={bridge}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        <Switch>
          <Route path={ROUTES.session}>{() => <ReviewWorkspace review={review} />}</Route>
        </Switch>
      </Router>
    </BridgeProvider>,
  );
  return { ...r, asked };
}

const OWN_SESSION = {
  id: SLUG,
  projectId: "p-1",
  title: "Sibling session",
  target: "your-branch",
  // The claim names the branch the OTHER repository of this workspace is on. If the route
  // derived the reviewed branch from here, every case below would answer the same way.
  claim: { branch: "main" },
  workBranch: "rennet/feat/x",
  createdAt: 0,
};

const strip = (container: Element | Document) =>
  container.querySelector('[data-testid="workspace-work-branch"]');

describe("the work-branch strip (workspace-settings D4)", () => {
  it("mounts beside the workspace when the ACTIVE patchset's branch is not the work branch", async () => {
    // Active patchset: `feat/x`. The session works on `rennet/feat/x`. They differ, so the
    // reviewer is told where the round's commits are. The FIRST patchset deliberately names
    // the work branch, so a `patchsets[0]` derivation would render nothing here.
    const r = mountWorkspace(reviewOn({ first: "rennet/feat/x", active: "feat/x" }), OWN_SESSION);
    await waitFor(() => {
      expect(strip(r.container)).not.toBeNull();
    });
    // …and it is the workspace's own strip, above the view region, not inside a greeting.
    expect(r.container.querySelector('[data-screen="round-greeting"]')).toBeNull();
    expect(r.asked).toEqual([{ sessionId: SLUG }]);
  });

  it("mounts NOTHING when the ACTIVE patchset's branch IS the work branch", async () => {
    // The mirror image: the swap moves `feat/x` to the inactive patchset. A derivation
    // reading the first element would render the strip here, which is the whole control.
    const r = mountWorkspace(reviewOn({ first: "feat/x", active: "rennet/feat/x" }), OWN_SESSION);
    await waitFor(() => {
      expect(r.container.querySelector('[data-region="board"]')).not.toBeNull();
    });
    expect(strip(r.container)).toBeNull();
  });

  it("mounts nothing, and does not throw, for a review with no patchsets at all", () => {
    // 4991d787's failure: an unguarded `.find` on an absent `patchsets` took the WHOLE
    // workspace down — 37 suites — for a decorative line. The fixtures this route is really
    // handed do carry such reviews.
    const review = {
      id: "rv-1",
      repositoryRoot: REPO,
      status: "current",
      activePatchsetId: "ps-active",
    } as unknown as Review;
    const r = mountWorkspace(review, OWN_SESSION);
    expect(strip(r.container)).toBeNull();
    expect(r.container.querySelector('[data-region="board"]')).not.toBeNull();
  });

  it("mounts nothing for a `share` session, which records no work branch at all", async () => {
    const r = mountWorkspace(reviewOn({ first: "rennet/feat/x", active: "feat/x" }), {
      ...OWN_SESSION,
      workBranch: undefined,
    });
    await waitFor(() => {
      expect(r.container.querySelector('[data-region="board"]')).not.toBeNull();
    });
    expect(strip(r.container)).toBeNull();
    // The read is not even made: there is no work branch to ask about.
    expect(r.asked).toEqual([]);
  });
});
