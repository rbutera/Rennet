// @vitest-environment happy-dom
//
// workspace-settings D6 — the workspace inventory is re-read when a round SETTLES WHILE
// THE READER IS ON SETTINGS.
//
// This is a claim about a subscription's LIFETIME, not about a fold, so it is driven
// through the whole app: the real router, the real Settings route, the real bridge push.
// The invalidation used to live in `useLiveRoundsSource`'s fold, which subscribes to the
// review THE ROUTE IS ON — and Settings is not a session route, so on the one screen that
// renders the inventory the subscription did not exist and the card described the tree as
// it stood before the round for as long as it was open. Mounting `ProjectsPage` alone
// could not have seen that: the defect is in what the surrounding app subscribes to.
import type { Project, RoundEvent, SettingsProject, SettingsView } from "@rennet/protocol";
import { RoundEventSchema } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { RennetRouterApp } from "../routes/app";
import { memoryHistory } from "../routes/history";
import { useRennetStore } from "../store";
import { act, cleanup, mount, waitFor } from "../test/dom";
import { sessionHandlers } from "../test/fixtures/sessions";
import { MemoryBridge } from "../test/memory-bridge";

const SESSION_ID = "session-w1";
const REVIEW_ID = "review-w1";
const REPO_PATH = "/repos/acme/checkout";

const PROJECT: Project = {
  id: "p1",
  name: "checkout",
  source: "local",
  path: "/repos/p1",
  kind: "repo",
  repoCount: 1,
  branchCount: 1,
  primaryBranch: "main",
  openPath: "/checkout",
  addedAt: "2026-08-01T00:00:00.000Z",
};

const ROW: SettingsProject = {
  projectId: "p1",
  name: "checkout",
  repoPath: REPO_PATH,
  visibility: "local",
  visibilityProvenance: {
    layer: "builtin",
    contributions: [{ layer: "builtin", value: "local", effective: true }],
  },
  promoted: false,
  promotedProvenance: {
    layer: "builtin",
    contributions: [{ layer: "builtin", value: "not promoted", effective: true }],
  },
  locus: { kind: "host" },
  locusProvenance: {
    layer: "builtin",
    contributions: [{ layer: "builtin", value: "host", effective: true }],
  },
  configMalformed: false,
};

function settings(): SettingsView {
  return {
    scheme: "system",
    schemeProvenance: {
      layer: "builtin",
      contributions: [{ layer: "builtin", value: "system", effective: true }],
    },
    appearanceMalformed: false,
    projects: [ROW],
    welcome: { completedAt: "2026-08-28T00:00:00.000Z" },
  };
}

/** A settled round: the durable terminal snapshot the daemon emits for a changed round. */
function settledRound(): RoundEvent {
  return RoundEventSchema.parse({
    type: "operation",
    snapshot: {
      operationId: "operation-1",
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

/** A round still RUNNING — the control that proves the assertion is about settling and
 *  not about "any frame at all re-reads the list". */
function claimedRound(): RoundEvent {
  return RoundEventSchema.parse({
    type: "operation",
    snapshot: {
      operationId: "operation-1",
      revision: 1,
      draining: false,
      createdAt: 1,
      roundNumber: 1,
      sourceTarget: { kind: "branch", branch: "feat/x" },
      askCount: 1,
      state: { phase: "claimed" },
    },
  });
}

function mountSettings() {
  let inventoryReads = 0;
  const bridge = new MemoryBridge({
    "app.bootstrap": () => ({ review: null, repositoryPresent: false }),
    "projects.list": () => ({ projects: [PROJECT] }),
    "project.detail": () => ({ viewer: { login: "rai" }, truncated: false, locals: [], prs: [] }),
    "harness.detect": () => ({ detected: [] }),
    "settings.get": () => settings(),
    ...sessionHandlers([{ id: SESSION_ID, projectId: "p1", reviewId: REVIEW_ID }]),
    "project.logos": () => ({ logos: [] }),
    "worktrees.list": () => {
      inventoryReads += 1;
      return { rows: [], truncated: false };
    },
  });
  const history = memoryHistory("/settings/projects?project=p1");
  const view = mount(<RennetRouterApp bridge={bridge} history={history} />);
  return {
    ...view,
    reads: () => inventoryReads,
    push: (event: RoundEvent) => act(() => bridge.emitRoundProgress(REVIEW_ID, event)),
  };
}

afterEach(() => {
  cleanup();
  act(() => {
    useRennetStore.getState().reviewActions.resetReview();
    useRennetStore.getState().runActions.resetRun();
  });
});

describe("the workspace inventory stays fresh on Settings (workspace-settings D6)", () => {
  // POSITIVE CONTROL RUN 2026-09-08: `<WorktreeInventoryFreshness />` was removed from
  // `routes/app.tsx` and this test reddened on the second `waitFor` (the read count never
  // moved past 1). Restored, green. The `claimed` case below reddens if the listener
  // invalidates on every frame instead of on a settled one.
  it("a round that settles while Settings is mounted re-reads the list", async () => {
    const view = mountSettings();
    // The card is on screen and has asked once.
    await view.findByText("Workspaces");
    await waitFor(() => expect(view.reads()).toBe(1));

    // A round still running changes nothing the list reports.
    view.push(claimedRound());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(view.reads()).toBe(1);

    // …and the settled one stales it, from a subscription the route never established.
    view.push(settledRound());
    await waitFor(() => expect(view.reads()).toBeGreaterThan(1));
  });
});
