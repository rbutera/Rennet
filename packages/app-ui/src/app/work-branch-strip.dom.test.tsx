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
import {
  type CommandOutput,
  type Review,
  type RoundEvent,
  RoundEventSchema,
  reviewSchema,
} from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Route, Router, Switch } from "wouter";
import { BridgeProvider } from "../data";
import { RennetRouterApp } from "../routes/app";
import { memoryHistory } from "../routes/history";
import { ROUTES, sessionPath } from "../routes/url";
import { useRennetStore } from "../store";
import { act, mount, waitFor } from "../test/dom";
import { frontDoorHandlers } from "../test/fixtures/front-door";
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
        aheadOfBranch: 1,
        behindRemote: 0,
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

/** The LINE inside the strip — the note's own output, which is what goes stale. */
const note = (container: Element | Document) =>
  container.querySelector('[data-testid="round-work-branch"]');

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

// ─────────────────────────────────────────────────────────────────────────────
// THE STRIP GOES STALE (review finding S1).
//
// `session.workBranchState` is a READ, and a read is cached. The strip is mounted on the
// workspace — above every view, deliberately, so the gap stays visible — which means it
// can sit through an entire round without re-rendering. Nothing invalidated it: the round
// stream re-asked `session.rounds` and `session.list`, and the strip's own read was
// untouched. So a session whose sibling had already been landed once kept the cached
// `landed: true` and rendered NOTHING while a fresh round put commits back on it.
//
// This mounts the WHOLE app, because the invalidation is in the round stream's fold
// (`useLiveRoundsSource`), which is bound above the route switch and does not exist when
// `ReviewWorkspace` is mounted on its own. Driving the component would prove nothing about
// the wiring, which is the entire finding.
// ─────────────────────────────────────────────────────────────────────────────

const ROUND_SESSION = "s-round";
const ROUND_REVIEW = "rv-round";

/** A review whose ACTIVE patchset is on `feat/x` — what the strip is measured against. */
const ROUND_REVIEW_DOC = reviewSchema.parse({
  id: ROUND_REVIEW,
  repositoryRoot: REPO,
  status: "current",
  activePatchsetId: "ps-1",
  dispositions: [],
  patchsets: [
    {
      id: "ps-1",
      createdAt: "2026-09-08T00:00:00.000Z",
      source: "local-branch",
      repository: {
        id: "widget",
        root: REPO,
        commonDir: `${REPO}/.git`,
        baseRef: "main",
        baseOid: "base-1",
        headOid: "head-1",
        headRef: "feat/x",
      },
      files: [],
      rawDiff: "",
      byteLength: 0,
      truncated: false,
    },
  ],
});

/** The terminal receipt of a round that CHANGED something — the event the fold acts on. */
function settledRound(): RoundEvent {
  return RoundEventSchema.parse({
    type: "operation",
    snapshot: {
      operationId: "op-1",
      revision: 2,
      draining: false,
      createdAt: 1,
      roundNumber: 1,
      sourceTarget: { kind: "branch", branch: "feat/x" },
      askCount: 1,
      state: {
        phase: "completed",
        workspace: { status: "done" },
        worker: { status: "done", fileCount: 1 },
        commits: { status: "done", count: 1 },
        result: {
          kind: "changed",
          report: { status: "verified", reportBoardId: "report-1", generation: "generation-b" },
        },
      },
    },
  });
}

/** The app, mounted on one session's workspace, over a work-branch state the test moves. */
function mountRoundJourney(initial: CommandOutput<"session.workBranchState">) {
  let state = initial;
  let reads = 0;
  const events: RoundEvent[] = [];
  const bridge = new MemoryBridge({
    ...frontDoorHandlers(),
    "session.list": () => ({
      sessions: [
        {
          id: ROUND_SESSION,
          projectId: "p-1",
          title: "Sibling session",
          target: "your-branch",
          reviewId: ROUND_REVIEW,
          workBranch: "rennet/feat/x",
          createdAt: 0,
        },
      ],
    }),
    "review.load": () => ({ review: ROUND_REVIEW_DOC, repositoryPresent: true }),
    "session.workBranchState": () => {
      reads += 1;
      return state;
    },
    "session.roundEvents": () => ({ events: [...events] }),
    "session.rounds": () => ({ records: [] }),
    "board.read": () => ({ board: null }),
    "ask.read": () => ({
      projection: {
        stagedAsks: {},
        findingDispositions: {},
        lineComments: {},
        quoteThreads: {},
        retired: {},
        verdictOverride: null,
      },
    }),
    "session.transcript": () => ({ trail: { title: "Sibling session" }, rows: [] }),
  } as never);
  const history = memoryHistory(sessionPath(ROUND_SESSION, { view: "diff" }));
  const view = mount(<RennetRouterApp bridge={bridge} history={history} />);
  return {
    ...view,
    reads: () => reads,
    /** What the daemon would answer NEXT — the refs moved, whether anybody re-asks or not. */
    setState: (next: CommandOutput<"session.workBranchState">) => {
      state = next;
    },
    settle: () => {
      const event = settledRound();
      events.push(event);
      act(() => bridge.emitRoundProgress(ROUND_REVIEW, event));
    },
  };
}

afterEach(() => {
  act(() => {
    useRennetStore.getState().reviewActions.resetReview();
    useRennetStore.getState().runActions.resetRun();
  });
});

// ONE settled state per step, and each one waited for by a `findBy*` that resolves on the
// DOM the step produces — never a chain of `waitFor`s over counters. Nx recorded this file
// flaky on an unchanged hash: three sequential `waitFor`s (each on the 1 s default) over a
// whole-app mount is three chances to lose a race with a machine under load, and a counter
// crossing a threshold is not the state the assertion after it depends on. The mount and
// the settle are the only two states this test has, so it waits for exactly two things.
const SETTLE_TIMEOUT_MS = 10_000;

describe("the work-branch strip after a round settles (review finding S1)", () => {
  it("re-reads the state and shows the gap a settled round opened", async () => {
    // The sibling had been landed: the strip renders nothing, and that answer is cached.
    const journey = mountRoundJourney({
      branch: "feat/x",
      workBranch: "rennet/feat/x",
      aheadOfBranch: 0,
      behindRemote: 0,
      pushed: false,
      landed: true,
    });
    // STEP 1's settled state is the strip's WRAPPER: the route mounts it whenever the
    // session works on another branch, so its presence proves the read has resolved and the
    // route has rendered its answer. The LINE is what a landed sibling withholds, and that
    // is the assertion — checked once the wrapper says the render happened, not on a
    // counter that can cross before React commits.
    await journey.findByTestId("workspace-work-branch", undefined, {
      timeout: SETTLE_TIMEOUT_MS,
    });
    expect(journey.reads()).toBeGreaterThan(0);
    expect(note(journey.container)).toBeNull();

    // The round commits on the sibling. THE REFS MOVE WHETHER THE CLIENT ASKS OR NOT — that
    // is why the daemon's answer changes before the event arrives, and why only a re-read
    // can find out.
    journey.setState({
      branch: "feat/x",
      workBranch: "rennet/feat/x",
      aheadOfBranch: 2,
      behindRemote: 0,
      pushed: false,
      landed: false,
    });
    const readsBefore = journey.reads();
    journey.settle();

    // STEP 2's settled state is the note appearing at all — which only a re-read can
    // produce, since the client's cached answer said `landed`. Waiting for the note rather
    // than for the read counter is what makes this one wait instead of two.
    const line = await journey.findByTestId("round-work-branch", undefined, {
      timeout: SETTLE_TIMEOUT_MS,
    });
    expect(journey.reads()).toBeGreaterThan(readsBefore);
    expect(line.textContent).toContain("The round's commits are on");
    expect(line.textContent).toContain("feat/x has not moved");
  });
});
