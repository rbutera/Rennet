// @vitest-environment happy-dom

import {
  type AskProjection,
  type Review,
  type RoundEvent,
  RoundEventSchema,
  type RoundOperationProgressState,
  reviewSchema,
} from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { RennetRouterApp } from "../routes/app";
import { memoryHistory } from "../routes/history";
import { sessionPath, sessionRunPath } from "../routes/url";
import { useRennetStore } from "../store";
import { act, cleanup, mount, waitFor } from "../test/dom";
import { frontDoorHandlers } from "../test/fixtures/front-door";
import { sessionHandlers } from "../test/fixtures/sessions";
import { MemoryBridge } from "../test/memory-bridge";

const SESSION_ID = "session-714";
const REVIEW_ID = "review-714";

const EMPTY_ASKS: AskProjection = {
  stagedAsks: {},
  findingDispositions: {},
  lineComments: {},
  quoteThreads: {},
  retired: {},
  verdictOverride: null,
};

type PatchsetId = "patchset-a" | "patchset-b" | "patchset-c";

const PATCHSET_PATHS: Readonly<Record<PatchsetId, string>> = {
  "patchset-a": "src/predecessor-a.ts",
  "patchset-b": "src/successor-b.ts",
  "patchset-c": "src/successor-c.ts",
};
const PATCHSET_IDS: readonly PatchsetId[] = ["patchset-a", "patchset-b", "patchset-c"];

function reviewAt(activePatchsetId: PatchsetId): Review {
  return reviewSchema.parse({
    id: REVIEW_ID,
    repositoryRoot: "/repo/owner-loop",
    patchsets: PATCHSET_IDS.map((id, index) => {
      const path = PATCHSET_PATHS[id];
      const patch = [
        "@@ -1,1 +1,1 @@",
        `-export const version = ${index};`,
        `+export const version = ${index + 1};`,
      ].join("\n");
      return {
        id,
        createdAt: `2026-08-31T00:00:0${index}.000Z`,
        repository: {
          id: "owner-loop",
          root: "/repo/owner-loop",
          commonDir: "/repo/owner-loop/.git",
          baseRef: "main",
          baseOid: `base-${index}`,
          headOid: `head-${index}`,
          headRef: "feature/owner-loop",
        },
        files: [
          {
            path,
            status: "modified",
            additions: 1,
            deletions: 1,
            binary: false,
            patch,
          },
        ],
        rawDiff: `diff --git a/${path} b/${path}\n${patch}`,
        byteLength: patch.length,
        truncated: false,
        source: "local-branch",
      };
    }),
    activePatchsetId,
    dispositions: [],
    status: "current",
  });
}

function operationEvent(
  roundNumber: number,
  revision: number,
  state: RoundOperationProgressState,
): RoundEvent {
  return RoundEventSchema.parse({
    type: "operation",
    snapshot: {
      operationId: `operation-${roundNumber}`,
      revision,
      draining: false,
      createdAt: roundNumber,
      roundNumber,
      sourceTarget: { kind: "branch", branch: "feature/owner-loop" },
      askCount: 1,
      gatePlan: { kind: "configured", command: "pnpm check" },
      state,
    },
  });
}

function claimed(roundNumber: number): RoundEvent {
  return operationEvent(roundNumber, 1, { phase: "claimed" });
}

function changed(roundNumber: number, generation: string): RoundEvent {
  return operationEvent(roundNumber, 2, {
    phase: "completed",
    workspace: { status: "done" },
    worker: { status: "done", fileCount: 1 },
    gate: { status: "passed", durationMs: 12, projectCount: 1 },
    commits: { status: "done", count: 1 },
    result: {
      kind: "changed",
      report: {
        status: "verified",
        reportBoardId: `report-${roundNumber}`,
        generation,
      },
    },
  });
}

function composed(generation: string): RoundEvent {
  return RoundEventSchema.parse({ type: "composed", generation });
}

function mountSuccessorJourney() {
  let activePatchsetId: PatchsetId = "patchset-a";
  let reviewLoads = 0;
  let sessionReads = 0;
  const events: RoundEvent[] = [];
  const sessions = sessionHandlers([
    { id: SESSION_ID, projectId: "project-714", reviewId: REVIEW_ID },
  ]);
  const listSessions = sessions["session.list"];
  if (listSessions === undefined) throw new Error("session fixture omitted session.list");

  const bridge = new MemoryBridge({
    ...frontDoorHandlers(),
    ...sessions,
    "session.list": (input) => {
      sessionReads += 1;
      return listSessions(input);
    },
    "review.load": () => {
      reviewLoads += 1;
      return { review: reviewAt(activePatchsetId), repositoryPresent: true };
    },
    "session.roundEvents": () => ({ events: [...events] }),
    "session.rounds": () => ({ records: [] }),
    "board.read": () => ({ board: null }),
    "ask.read": () => ({ projection: EMPTY_ASKS }),
    "review.reattach": () => ({ threads: [], inFlight: [] }),
    "session.transcript": () => ({ trail: { title: "Owner loop" }, rows: [] }),
  });
  const history = memoryHistory(sessionPath(SESSION_ID, { view: "diff" }));
  const view = mount(<RennetRouterApp bridge={bridge} history={history} />);
  const push = (event: RoundEvent) => {
    events.push(event);
    act(() => bridge.emitRoundProgress(REVIEW_ID, event));
  };

  return {
    ...view,
    history,
    push,
    setActivePatchset: (id: PatchsetId) => {
      activePatchsetId = id;
    },
    reviewLoads: () => reviewLoads,
    sessionReads: () => sessionReads,
  };
}

afterEach(() => {
  cleanup();
  act(() => {
    useRennetStore.getState().reviewActions.resetReview();
    useRennetStore.getState().runActions.resetRun();
  });
});

describe("successor Review refresh after a changed round (#714)", () => {
  it("moves one mounted app from Diff A to B to C after two changed rounds", async () => {
    const journey = mountSuccessorJourney();

    expect(await journey.findByText(PATCHSET_PATHS["patchset-a"])).toBeTruthy();
    await waitFor(() => expect(journey.reviewLoads()).toBe(1));

    journey.push(claimed(1));
    act(() => journey.history.navigate(sessionRunPath(SESSION_ID)));
    await waitFor(() =>
      expect(
        journey.container.querySelector('[data-screen="session-run"]')?.getAttribute("data-phase"),
      ).toBe("dispatching"),
    );
    journey.setActivePatchset("patchset-b");
    journey.push(changed(1, "generation-b"));
    await waitFor(() => expect(journey.history.history.at(-1)).toBe(sessionPath(SESSION_ID)));
    act(() => journey.history.navigate(sessionPath(SESSION_ID, { view: "diff" })));

    expect(await journey.findByText(PATCHSET_PATHS["patchset-b"])).toBeTruthy();
    expect(journey.queryByText(PATCHSET_PATHS["patchset-a"])).toBeNull();
    await waitFor(() => expect(journey.reviewLoads()).toBe(2));
    const readsBeforeLegacyReceipt1 = journey.sessionReads();
    journey.push(composed("generation-b"));
    await waitFor(() => expect(journey.sessionReads()).toBeGreaterThan(readsBeforeLegacyReceipt1));
    expect(journey.reviewLoads()).toBe(2);

    journey.push(claimed(2));
    act(() => journey.history.navigate(sessionRunPath(SESSION_ID)));
    await waitFor(() =>
      expect(
        journey.container.querySelector('[data-screen="session-run"]')?.getAttribute("data-phase"),
      ).toBe("dispatching"),
    );
    journey.setActivePatchset("patchset-c");
    journey.push(changed(2, "generation-c"));
    await waitFor(() => expect(journey.history.history.at(-1)).toBe(sessionPath(SESSION_ID)));
    act(() => journey.history.navigate(sessionPath(SESSION_ID, { view: "diff" })));

    expect(await journey.findByText(PATCHSET_PATHS["patchset-c"])).toBeTruthy();
    expect(journey.queryByText(PATCHSET_PATHS["patchset-b"])).toBeNull();
    expect(journey.queryByText(PATCHSET_PATHS["patchset-a"])).toBeNull();
    await waitFor(() => expect(journey.reviewLoads()).toBe(3));
    const readsBeforeLegacyReceipt2 = journey.sessionReads();
    journey.push(composed("generation-c"));
    await waitFor(() => expect(journey.sessionReads()).toBeGreaterThan(readsBeforeLegacyReceipt2));
    expect(journey.reviewLoads()).toBe(3);
  });

  it("does not refresh Review for failed or unchanged terminal receipts", async () => {
    const journey = mountSuccessorJourney();
    expect(await journey.findByText(PATCHSET_PATHS["patchset-a"])).toBeTruthy();
    await waitFor(() => expect(journey.reviewLoads()).toBe(1));

    const readsBeforeFailure = journey.sessionReads();
    journey.push(RoundEventSchema.parse({ type: "failed", reason: "worker failed" }));
    await waitFor(() => expect(journey.sessionReads()).toBeGreaterThan(readsBeforeFailure));
    expect(journey.reviewLoads()).toBe(1);

    const readsBeforeUnchanged = journey.sessionReads();
    journey.push(RoundEventSchema.parse({ type: "unchanged" }));
    await waitFor(() => expect(journey.sessionReads()).toBeGreaterThan(readsBeforeUnchanged));
    expect(journey.reviewLoads()).toBe(1);
    expect(journey.getByText(PATCHSET_PATHS["patchset-a"])).toBeTruthy();
  });
});
