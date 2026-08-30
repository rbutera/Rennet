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
import { newChatPath, projectIndexingPath, projectMapPath } from "../../routes/url";
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
  guessed: 2,
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
      key: "worktreeBaseDir",
      value: "~/.rennet/worktrees",
      provenance: "guessed",
      source: "Rennet default",
      hint: "coding rounds create worktrees here",
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
    totals: { repos: 1, files: 456, scopes: 12, confirmed: 3, rejected: 1 },
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
    phase: "knowledge",
    repos: [SUMMARY],
    scout: QUESTIONNAIRE,
    reason: "rennet: knowledge verification failed",
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
    expect(screen.getAllByText("guessed")).toHaveLength(2);
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

  it("keeps header and sidebar processing until knowledge settles, then uses the run totals", async () => {
    const run = renderView("p3", true);
    await waitFor(() => expect(run.commandId()).not.toBe(""));
    run.emit({
      kind: "run-state",
      runId: run.commandId(),
      projectId: "p3",
      phase: "knowledge",
      status: "running",
    });
    run.emit({
      kind: "step",
      runId: run.commandId(),
      repo: "rennet",
      phase: "knowledge",
      step: "verify",
      status: "running",
      note: "Verifying hypotheses against cited evidence",
    });

    expect(selectProcessingProjectIds(useRennetStore.getState())).toContain("p3");
    expect(screen.queryByText("Context Map Ready")).toBeNull();
    expect(screen.getByText("Verifying hypotheses against cited evidence")).toBeTruthy();

    const terminal = doneRun("p3", run.commandId());
    act(() => run.process.resolve({ repos: [SUMMARY], run: terminal }));
    await waitFor(() => expect(screen.getByText("Context Map Ready")).toBeTruthy());
    expect(screen.getByText("indexed")).toBeTruthy();
    expect(screen.getByText(/12 scopes · 456 files · 3 confirmed · 1 rejected/)).toBeTruthy();
    expect(selectProcessingProjectIds(useRennetStore.getState())).not.toContain("p3");
  });

  it("never reports ready when knowledge fails and still keeps Start a Review available", async () => {
    const run = renderView("p4");
    await waitFor(() => expect(run.commandId()).not.toBe(""));
    const terminal = failedRun("p4", run.commandId());
    act(() => run.process.resolve({ repos: [SUMMARY], run: terminal }));

    await waitFor(() => expect(screen.getByText("Project knowledge failed")).toBeTruthy());
    expect(screen.queryByText("Context Map Ready")).toBeNull();
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
    await waitFor(() => expect(screen.getByText("Context Map Ready")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Looks right" })).toBeTruthy();

    await run.user.click(screen.getByRole("button", { name: "View Context Map" }));
    expect(run.history.history.at(-1)).toBe(projectMapPath("p5"));
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
