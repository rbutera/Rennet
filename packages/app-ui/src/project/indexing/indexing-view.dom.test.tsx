// @vitest-environment happy-dom
import type {
  ProcessedRepoSummary,
  Project,
  ProjectProcessEvent,
  ProjectProcessRun,
  ProjectScoutQuestionnaire,
} from "@rennet/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { BridgeProvider } from "../../data";
import { memoryHistory } from "../../routes/history";
import { newChatPath, projectIndexingPath } from "../../routes/url";
import { Sidebar } from "../../shell/sidebar/sidebar";
import { selectProcessingProjectIds, useRennetStore } from "../../store";
import { act, cleanup, fireEvent, mount, screen, waitFor } from "../../test/dom";
import { MemoryBridge } from "../../test/memory-bridge";
import { IndexingView } from "./indexing-view";

afterEach(() => {
  cleanup();
  useRennetStore.setState((state) => ({
    ui: { ...state.ui, openDialogs: [], processingProjectIds: [], backgroundEvents: {} },
  }));
});

function project(id: string): Project {
  return {
    id,
    name: "rennet",
    path: "/home/rai/rennet",
    kind: "repo",
    repoCount: 1,
    branchCount: 3,
    primaryBranch: "trunk",
    openPath: "/home/rai/rennet",
    addedAt: "2026-08-27T00:00:00.000Z",
    source: "local",
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const QUESTIONNAIRE: ProjectScoutQuestionnaire = {
  repo: "rennet",
  detected: 3,
  guessed: 1,
  answers: [
    {
      key: "trackerKind",
      value: "github",
      provenance: "detected",
      source: ".github directory",
      hint: "referenced tickets feed review context",
      options: ["github", "jira", "linear", "none"],
    },
    {
      key: "defaultBranch",
      value: "trunk",
      provenance: "detected",
      source: "origin/HEAD",
      hint: "the structural map reads this branch",
    },
    {
      key: "gateCommand",
      value: "pnpm check",
      provenance: "detected",
      source: "package.json scripts",
      hint: "coding rounds run this before handoff",
    },
    {
      key: "logoPath",
      value: "docs/mark.svg",
      provenance: "guessed",
      source: "repository image candidates",
      hint: "cosmetic repository evidence only; choose the sidebar mark in Settings → Projects → Identity",
    },
  ],
};

const SUMMARY: ProcessedRepoSummary = {
  repo: "rennet",
  path: "/home/rai/rennet",
  ok: true,
  files: 456,
  symbols: 1200,
};

function doneRun(id: string, commandId: string): ProjectProcessRun {
  return {
    id: commandId,
    projectId: id,
    status: "done",
    phase: "complete",
    repos: [SUMMARY],
    scout: QUESTIONNAIRE,
    totals: { repos: 1, files: 456, scopes: 12 },
  };
}

function failedRun(
  id: string,
  commandId: string,
): Extract<ProjectProcessRun, { status: "failed" }> {
  return {
    id: commandId,
    projectId: id,
    status: "failed",
    phase: "map",
    repos: [SUMMARY],
    scout: QUESTIONNAIRE,
    reason: "rennet: the structural map failed to build",
  };
}

function renderView(id: string, withSidebar = false) {
  const history = memoryHistory(projectIndexingPath(id));
  const process = deferred<{ repos: ProcessedRepoSummary[]; run?: ProjectProcessRun }>();
  let commandId = "";
  const bridge = new MemoryBridge({
    "projects.list": () => ({ projects: [project(id)] }),
    "project.process": (input) => {
      commandId = input.commandId;
      return process.promise;
    },
  });
  const view = mount(
    <BridgeProvider bridge={bridge}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        {withSidebar ? <Sidebar /> : null}
        <IndexingView projectId={id} />
      </Router>
    </BridgeProvider>,
  );
  const emit = (event: ProjectProcessEvent) => act(() => bridge.emitProgress(commandId, event));
  return { ...view, bridge, emit, history, process, commandId: () => commandId };
}

describe("IndexingView — one durable project run", () => {
  it("labels the Back control with a back arrow, not the Context Map's glyph", async () => {
    // The bug this exists for: Back rendered lucide's MAP icon, so the one control that
    // leaves the run announced itself as "open the Context Map" and went to New Chat.
    const run = renderView("p1");
    await waitFor(() => expect(run.commandId()).not.toBe(""));
    const back = screen.getByLabelText("Back");
    expect(back.querySelector("svg")?.getAttribute("class")).toContain("lucide-arrow-left");
  });

  it("starts in scouting and reveals only the persisted questionnaire returned by the scout", async () => {
    const run = renderView("p1");
    await waitFor(() => expect(run.commandId()).not.toBe(""));
    expect(screen.getByText("scouting")).toBeTruthy();
    expect(screen.queryByText(/does this look right/i)).toBeNull();

    run.emit({
      kind: "step",
      runId: run.commandId(),
      repo: "rennet",
      phase: "scout",
      step: "returned",
      status: "done",
      note: "Scout returned",
      detail: "3 detected, 2 guessed",
    });
    run.emit({
      kind: "scout-ready",
      runId: run.commandId(),
      repo: "rennet",
      questionnaire: QUESTIONNAIRE,
    });

    await waitFor(() =>
      expect(screen.getByText(/Scout finished.*does this look right/)).toBeTruthy(),
    );
    expect((screen.getByLabelText("Default branch") as HTMLInputElement).value).toBe("trunk");
    expect((screen.getByLabelText("Logo / mark") as HTMLInputElement).value).toBe("docs/mark.svg");
    expect(screen.getAllByText("detected")).toHaveLength(3);
    expect(screen.getAllByText("guessed")).toHaveLength(1);
    // Four rows, not five: the worktree convention is scouted but never asked about
    // (#812) — it steers nothing, so a field for it changed nothing.
    expect(screen.queryByLabelText("Worktree location")).toBeNull();
    expect(screen.getByText(/origin\/HEAD/)).toBeTruthy();

    run.emit({
      kind: "run-state",
      runId: run.commandId(),
      projectId: "p1",
      phase: "map",
      status: "running",
    });
    await waitFor(() => expect(screen.getByText("indexing")).toBeTruthy());
  });

  it("puts the questionnaire BETWEEN the scout steps and the map steps", async () => {
    // The scout reads, the questionnaire asks about what it read, and the map is built
    // with the answers. The view used to render the questions above the whole timeline,
    // so the answer arrived before the question and the map steps read as if they had
    // come first. Order is the assertion — DOM position, not membership.
    const run = renderView("p6");
    await waitFor(() => expect(run.commandId()).not.toBe(""));
    run.emit({
      kind: "step",
      runId: run.commandId(),
      repo: "rennet",
      phase: "scout",
      step: "returned",
      status: "done",
      note: "Scout returned",
    });
    run.emit({
      kind: "scout-ready",
      runId: run.commandId(),
      repo: "rennet",
      questionnaire: QUESTIONNAIRE,
    });
    run.emit({
      kind: "step",
      runId: run.commandId(),
      repo: "rennet",
      phase: "map",
      step: "tree",
      status: "running",
      note: "Scanned the working tree",
    });

    const scout = await screen.findByText("Scout returned");
    const questions = screen.getByText(/does this look right/);
    const map = await screen.findByText(/Scanned the working tree/);

    const precedes = (a: Node, b: Node) =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(precedes(scout, questions)).toBe(true);
    expect(precedes(questions, map)).toBe(true);
  });

  it("puts the questionnaire ABOVE a legacy unstamped timeline — the deliberate degrade", async () => {
    // DELIBERATE, not a bug to normalize away. `scoutBoundary` reads the host's OWN phase
    // stamp (`scout-ready`, or a `step` with `phase: "scout"`). The legacy narration events —
    // `repo-start` / `stage` / `repo-done` — carry no phase at all, so the boundary is 0 and
    // every line lands in the map slice, under the questionnaire.
    //
    // That is exactly the layout Rennet shipped before the seam existed, and it is the only
    // honest one available: with no stamp, ANY split would be the renderer inventing a phase
    // the host never claimed, and a guessed cut is worse than a known-old one. So this test
    // pins the degrade rather than a fix — if the boundary ever starts inferring phases from
    // labels, this goes red and that is the point.
    const run = renderView("p-legacy");
    await waitFor(() => expect(run.commandId()).not.toBe(""));
    run.emit({ kind: "repo-start", repo: "rennet", index: 1, total: 1 });
    run.emit({ kind: "stage", repo: "rennet", stage: "tree", note: "Reading the file tree" });
    run.emit({ kind: "repo-done", repo: "rennet", summary: SUMMARY });
    // A legacy host answers `done` with repos and no `run`; the questionnaire arrives on the
    // terminal run instead, which is the case the boundary-0 fallback has to render.
    await act(async () => {
      run.process.resolve({ repos: [SUMMARY], run: doneRun("p-legacy", run.commandId()) });
    });

    const questions = await screen.findByText(/does this look right/);
    const precedes = (a: Node, b: Node) =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    for (const label of [/Building rennet/, /Reading the file tree/, /Finished rennet/]) {
      expect(precedes(questions, screen.getByText(label))).toBe(true);
    }
  });

  it("replaces a replayed step in place and renders its explicit running/done state", async () => {
    const run = renderView("p2");
    await waitFor(() => expect(run.commandId()).not.toBe(""));
    const base = {
      kind: "step" as const,
      runId: run.commandId(),
      repo: "rennet",
      phase: "map" as const,
      step: "tree",
      note: "Scanned the working tree",
    };
    run.emit({ ...base, status: "running" });
    await waitFor(() => expect(screen.getByText("Scanned the working tree")).toBeTruthy());
    expect(screen.getByText("Scanned the working tree").closest("div")?.dataset.stepStatus).toBe(
      "running",
    );

    run.emit({ ...base, status: "done", detail: "456 files · 12 scopes" });
    await waitFor(() =>
      expect(screen.getByText(/Scanned the working tree · 456 files · 12 scopes/)).toBeTruthy(),
    );
    expect(screen.getAllByText(/Scanned the working tree/)).toHaveLength(1);
    expect(screen.getByText(/Scanned the working tree/).closest("div")?.dataset.stepStatus).toBe(
      "done",
    );
  });

  it("keeps header and sidebar processing until the run settles, then uses the run totals", async () => {
    const run = renderView("p3", true);
    await waitFor(() => expect(run.commandId()).not.toBe(""));
    run.emit({
      kind: "run-state",
      runId: run.commandId(),
      projectId: "p3",
      phase: "map",
      status: "running",
    });

    expect(selectProcessingProjectIds(useRennetStore.getState())).toContain("p3");
    expect(screen.queryByText("Project Ready")).toBeNull();

    const terminal = doneRun("p3", run.commandId());
    act(() => run.process.resolve({ repos: [SUMMARY], run: terminal }));
    await waitFor(() => expect(screen.getByText("Project Ready")).toBeTruthy());
    expect(screen.getByText("indexed")).toBeTruthy();
    expect(screen.getByText(/12 scopes · 456 files/)).toBeTruthy();
    expect(selectProcessingProjectIds(useRennetStore.getState())).not.toContain("p3");
  });

  it("never reports ready when the map fails and still keeps Start a Review available", async () => {
    const run = renderView("p4");
    await waitFor(() => expect(run.commandId()).not.toBe(""));
    const terminal = failedRun("p4", run.commandId());
    act(() => run.process.resolve({ repos: [SUMMARY], run: terminal }));

    await waitFor(() => expect(screen.getByText("Project map failed")).toBeTruthy());
    expect(screen.queryByText("Project Ready")).toBeNull();
    expect(screen.getByText(terminal.reason)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Start a Review/ })).toBeTruthy();
  });

  it("does not gate completion on the questionnaire and keeps both exits live", async () => {
    const run = renderView("p5");
    await waitFor(() => expect(run.commandId()).not.toBe(""));
    run.emit({
      kind: "scout-ready",
      runId: run.commandId(),
      repo: "rennet",
      questionnaire: QUESTIONNAIRE,
    });
    expect(await screen.findByRole("button", { name: "Looks right" })).toBeTruthy();

    act(() => run.process.resolve({ repos: [SUMMARY], run: doneRun("p5", run.commandId()) }));
    await waitFor(() => expect(screen.getByText("Project Ready")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Looks right" })).toBeTruthy();

    await run.user.click(screen.getByRole("button", { name: "Start a Review" }));
    expect(run.history.history.at(-1)).toBe(newChatPath("p5"));
  });

  it("Escape inside a scout field blurs it without leaving the run", async () => {
    const run = renderView("p6");
    await waitFor(() => expect(run.commandId()).not.toBe(""));
    run.emit({
      kind: "scout-ready",
      runId: run.commandId(),
      repo: "rennet",
      questionnaire: QUESTIONNAIRE,
    });
    const field = (await screen.findByLabelText("Default branch")) as HTMLInputElement;
    act(() => field.focus());
    fireEvent.keyDown(field, { key: "Escape" });
    expect(document.activeElement).not.toBe(field);
    expect(run.history.history.at(-1)).toBe(projectIndexingPath("p6"));
  });

  it("leaving does not cancel the run; its sidebar state clears only when the command resolves", async () => {
    const run = renderView("p7", true);
    await waitFor(() =>
      expect(selectProcessingProjectIds(useRennetStore.getState())).toContain("p7"),
    );
    act(() => run.unmount());
    expect(selectProcessingProjectIds(useRennetStore.getState())).toContain("p7");

    act(() => run.process.resolve({ repos: [SUMMARY], run: doneRun("p7", run.commandId()) }));
    await waitFor(() =>
      expect(selectProcessingProjectIds(useRennetStore.getState())).not.toContain("p7"),
    );
  });

  it("scrolls the primary exit into view only at the shared terminal boundary", async () => {
    const scroll = vi.fn();
    const prior = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    try {
      const run = renderView("p8");
      await waitFor(() => expect(run.commandId()).not.toBe(""));
      expect(scroll).not.toHaveBeenCalled();
      act(() => run.process.resolve({ repos: [SUMMARY], run: doneRun("p8", run.commandId()) }));
      await waitFor(() => expect(scroll).toHaveBeenCalled());
    } finally {
      Element.prototype.scrollIntoView = prior;
    }
  });
});
