// @vitest-environment happy-dom
//
// The background narration channel (#592). Two defects, both fixed here:
//
//  1. The channel was ONE process-global command id, so every project's
//     background pass was broadcast onto every project's build timeline.
//  2. The indexing screen owned the subscription, so a knowledge pass that
//     failed while the reader was elsewhere left nothing behind — the line was
//     visible only to whoever happened to be looking when it arrived, which is
//     barely more visible than never narrating it at all.
import type { ProcessedRepoSummary, Project, ProjectProcessEvent } from "@rennet/protocol";
import { proactiveRehydrationCommandId } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Router } from "wouter";
import { BridgeProvider } from "../../data";
import { memoryHistory } from "../../routes/history";
import { projectIndexingPath } from "../../routes/url";
import { useRennetStore } from "../../store";
import { act, cleanup, mount, screen, waitFor } from "../../test/dom";
import { MemoryBridge } from "../../test/memory-bridge";
import { BackgroundNarration } from "./background-narration";
import { IndexingView } from "./indexing-view";

afterEach(() => {
  cleanup();
  useRennetStore.setState((s) => ({
    ui: { ...s.ui, processingProjectIds: [], backgroundEvents: {} },
  }));
});

function project(id: string): Project {
  return {
    id,
    name: id,
    path: `/home/rai/${id}`,
    kind: "repo",
    repoCount: 1,
    branchCount: 1,
    primaryBranch: "main",
    openPath: `/home/rai/${id}`,
    addedAt: "2026-08-28T00:00:00.000Z",
    source: "local",
  };
}

const knowledgeFailed: ProjectProcessEvent = {
  kind: "stage",
  repo: "rennet",
  stage: "build",
  note: "Knowledge pass failed",
  detail: "Prompt is too long",
};

/** Mount the always-on collector plus a detachable indexing screen for `id`. */
function harness(ids: readonly string[]) {
  const history = memoryHistory(projectIndexingPath(ids[0] ?? ""));
  const bridge = new MemoryBridge({
    "projects.list": () => ({ projects: ids.map(project) }),
    // The build itself resolves immediately — this test is about what happens
    // AFTER it, on the background channel.
    "project.process": () => ({ repos: [] as ProcessedRepoSummary[] }),
  });
  mount(
    <BridgeProvider bridge={bridge}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        <BackgroundNarration />
      </Router>
    </BridgeProvider>,
  );
  const openScreen = (id: string) =>
    mount(
      <BridgeProvider bridge={bridge}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          <IndexingView projectId={id} />
        </Router>
      </BridgeProvider>,
    );
  const emitFor = (id: string, event: ProjectProcessEvent) =>
    act(() => bridge.emitProgress(proactiveRehydrationCommandId(id), event));
  return { openScreen, emitFor };
}

describe("background narration", () => {
  it("retains a failure that arrived while the screen was closed", async () => {
    const { openScreen, emitFor } = harness(["alpha"]);
    // The reader watches the build finish, then leaves.
    const first = openScreen("alpha");
    await waitFor(() => expect(screen.getByText(/indexed|indexing/)).toBeTruthy());
    act(() => first.unmount());

    // Nobody is looking: the swarm runs for minutes after `project.process`
    // resolves, and this is exactly when it dies.
    emitFor("alpha", knowledgeFailed);
    await waitFor(() =>
      expect(useRennetStore.getState().ui.backgroundEvents.alpha).toHaveLength(1),
    );

    // The reader comes back and the reason is still there.
    openScreen("alpha");
    await waitFor(() => expect(document.body.textContent).toContain("Knowledge pass failed"));
    expect(document.body.textContent).toContain("Prompt is too long");
  });

  it("starts a clean timeline when a new background pass begins", async () => {
    const { openScreen, emitFor } = harness(["alpha"]);
    openScreen("alpha");
    await waitFor(() => expect(screen.getByText(/indexed|indexing/)).toBeTruthy());

    emitFor("alpha", knowledgeFailed);
    await waitFor(() =>
      expect(useRennetStore.getState().ui.backgroundEvents.alpha).toHaveLength(1),
    );

    // A new pass begins. The reader must not read last run's failure under this
    // run's lines with nothing saying where one ended and the next began.
    emitFor("alpha", { kind: "repo-start", repo: "rennet", index: 1, total: 1 });
    await waitFor(() => expect(document.body.textContent).toContain("Building rennet"));
    expect(useRennetStore.getState().ui.backgroundEvents.alpha).toHaveLength(1);
    expect(document.body.textContent).not.toContain("Knowledge pass failed");
  });

  it("keeps one project's background pass off another project's timeline", async () => {
    const { openScreen, emitFor } = harness(["alpha", "beta"]);
    openScreen("alpha");
    await waitFor(() => expect(screen.getByText(/indexed|indexing/)).toBeTruthy());

    emitFor("beta", knowledgeFailed);

    // Beta's swarm is beta's business. Alpha's timeline never learns about it.
    await waitFor(() => expect(useRennetStore.getState().ui.backgroundEvents.beta).toHaveLength(1));
    expect(useRennetStore.getState().ui.backgroundEvents.alpha).toBeUndefined();
    expect(document.body.textContent).not.toContain("Knowledge pass failed");
  });
});
