// @vitest-environment happy-dom
//
// Open-via-pill E2E (Objective A, packet V2): the real C3 top-bar pill and the review
// workspace share one Router; clicking **Diff** navigates to ?view=diff and the workspace
// swaps its placeholder for the live diff surface — the pill and the mount, end to end.
import type { PatchFile, Project, Review } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Router } from "wouter";
import { ReviewWorkspace } from "../app/review-workspace-route";
import { BridgeProvider } from "../data";
import { memoryHistory } from "../routes/history";
import {
  type SidebarSession,
  type SidebarSessionProjection,
  SidebarSessionProjectionProvider,
} from "../shell/sidebar-data";
import { TopBar } from "../shell/top-bar";
import { useRennetStore } from "../store";
import { cleanup, mount } from "../test/dom";
import { frontDoorHandlers } from "../test/fixtures/front-door";
import { MemoryBridge } from "../test/memory-bridge";

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

function review(): Review {
  return {
    id: "s2",
    repositoryRoot: "/repos/atlas",
    patchsets: [{ id: "ps1", files: [FILE] }],
    activePatchsetId: "ps1",
  } as unknown as Review;
}

function project(id: string, name: string): Project {
  return {
    id,
    name,
    path: `/repos/${id}`,
    kind: "repo",
    repoCount: 1,
    branchCount: 1,
    primaryBranch: "main",
    openPath: `/repos/${id}`,
    addedAt: "2026-08-27T00:00:00.000Z",
    source: "local",
  };
}

const SESSIONS: Record<string, readonly SidebarSession[]> = {
  p1: [
    { id: "s2", slug: "s2", title: "Beta", time: "1d", target: "your-pr", targetState: "reviewed" },
  ],
};

function mountApp() {
  const history = memoryHistory("/s/s2");
  const bridge = new MemoryBridge(frontDoorHandlers([project("p1", "atlas")]));
  const projection: SidebarSessionProjection = {
    sessionsByProject: SESSIONS,
    renameSession: () => undefined,
    setSessionPinned: () => undefined,
    archiveSession: () => undefined,
    restoreSession: () => undefined,
    renameProject: () => undefined,
  };
  return mount(
    <BridgeProvider bridge={bridge}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        <SidebarSessionProjectionProvider value={projection}>
          <TopBar />
          <ReviewWorkspace review={review()} />
        </SidebarSessionProjectionProvider>
      </Router>
    </BridgeProvider>,
  );
}

describe("open the diff via the top-bar pill", () => {
  it("clicking Diff navigates to ?view=diff and renders the diff surface", async () => {
    const { getByText, queryByText, user } = mountApp();
    // Board view first: the honest placeholder, no diff surface.
    expect(getByText(/being rebuilt/i)).toBeTruthy();
    expect(queryByText("1 files changed")).toBeNull();
    // Click the pill's Diff toggle.
    await user.click(getByText("Diff"));
    // The workspace now renders the live surface for the active patchset.
    expect(getByText("1 files changed")).toBeTruthy();
    expect(getByText("packages/core/src/a.ts")).toBeTruthy();
    expect(queryByText(/being rebuilt/i)).toBeNull();
  });
});
