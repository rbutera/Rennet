// @vitest-environment happy-dom
//
// The project indexing view (C12 §10.4/§10.5) over a MemoryBridge. Narration rides the REAL
// `project.process` `onProgress` channel (emitted by the test, never a timer) in the honest
// production ORDER — per repo, `repo-start` → `stage`* → `repo-done` — which IS the map build;
// there is no scout narration on this channel. The prefilled questionnaire appears immediately
// (the deterministic scout ran at add time) with honest provenance, and — the never-a-gate
// positive control — the map completes and its exits appear with the questionnaire untouched.
// The completion block states the honest outcome: ready / partial / failed / map-unavailable.
import type {
  ProcessedRepoSummary,
  Project,
  ProjectContextMapResult,
  ProjectProcessEvent,
} from "@rennet/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { BridgeProvider } from "../../data";
import { memoryHistory } from "../../routes/history";
import { newChatPath, projectIndexingPath, projectMapPath } from "../../routes/url";
import { Sidebar } from "../../shell/sidebar/sidebar";
import { selectProcessingProjectIds, useRennetStore } from "../../store";
import { act, cleanup, fireEvent, mount, screen, waitFor } from "../../test/dom";
import { MemoryBridge, type MemoryBridgeHandlers } from "../../test/memory-bridge";
import { IndexingView } from "./indexing-view";

afterEach(() => {
  cleanup();
  useRennetStore.setState((s) => ({ ui: { ...s.ui, openDialogs: [], processingProjectIds: [] } }));
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

/** A promise with exposed resolve + reject, to hold `project.process` in flight. */
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

/** Mount the view at its route, capturing the commandId the view minted for
 *  `project.process` so the test can drive its `onProgress` channel. */
function renderView(id: string, extra: MemoryBridgeHandlers = {}) {
  const history = memoryHistory(projectIndexingPath(id));
  const process = deferred<{ repos: ProcessedRepoSummary[] }>();
  let commandId = "";
  const bridge = new MemoryBridge({
    "projects.list": () => ({ projects: [project(id)] }),
    "project.process": (input) => {
      commandId = input.commandId;
      return process.promise;
    },
    ...extra,
  });
  const view = mount(
    <BridgeProvider bridge={bridge}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        <IndexingView projectId={id} />
      </Router>
    </BridgeProvider>,
  );
  const emit = (event: ProjectProcessEvent) => act(() => bridge.emitProgress(commandId, event));
  const finishWith = (repos: readonly ProcessedRepoSummary[]) =>
    act(() => process.resolve({ repos: repos as ProcessedRepoSummary[] }));
  const finish = () => finishWith([]);
  const fail = () => act(() => process.reject(new Error("daemon disconnected")));
  return { ...view, history, emit, finish, finishWith, fail, commandIdRef: () => commandId };
}

const okSummary = (files: number, symbols: number): ProcessedRepoSummary => ({
  repo: "rennet",
  path: "/home/rai/rennet",
  ok: true,
  files,
  symbols,
});

const failedSummary = (repo: string, error: string): ProcessedRepoSummary =>
  ({ repo, path: `/home/rai/${repo}`, ok: false, error }) as ProcessedRepoSummary;

/** A minimal `project.contextMap` `ok` result — the view reads only scope count and
 *  statement dispositions, so the rest of the (large) map payload is elided. */
function contextMapOk(
  scopes: number,
  confirmed: number,
  rejected: number,
): ProjectContextMapResult {
  const statements = [
    ...Array.from({ length: confirmed }, (_, i) => ({ id: `c${i}`, status: "confirmed" as const })),
    ...Array.from({ length: rejected }, (_, i) => ({ id: `r${i}`, status: "rejected" as const })),
  ];
  return {
    status: "ok",
    map: { scopes: Array.from({ length: scopes }, (_, i) => ({ name: `s${i}` })) },
    knowledge: { statements },
  } as unknown as ProjectContextMapResult;
}

const stage = (note: string, detail?: string): ProjectProcessEvent => ({
  kind: "stage",
  repo: "rennet",
  stage: "resolve",
  note,
  detail,
});

const repoStart: ProjectProcessEvent = { kind: "repo-start", repo: "rennet", index: 1, total: 1 };

/** The row a StepLine renders the given text in (for spinner-vs-tick assertions). */
function stepRow(text: RegExp): HTMLElement {
  return screen.getByText(text).closest("div") as HTMLElement;
}

describe("IndexingView — prefilled questionnaire", () => {
  it("prefills immediately with honest provenance (the deterministic scout ran at add time)", async () => {
    renderView("p2");
    // The questionnaire is offered as soon as the project loads — no fabricated wait for a
    // scout-returned signal on the build channel.
    await waitFor(() => expect(screen.getByText(/does this look right/)).toBeTruthy());

    // Default branch is the ONLY real signal this view has — from the project's primary branch.
    expect((screen.getByLabelText("Default branch") as HTMLInputElement).value).toBe("trunk");
    // Branch is detected; tracker/worktrees/gate/logo are honest guesses (the model-backed
    // scout that would detect them is B7, with no client-reachable signal here).
    expect(screen.getAllByText("detected")).toHaveLength(1);
    expect(screen.getAllByText("guessed")).toHaveLength(4);
    expect(screen.getByText(/1 detected · 4 guessed/)).toBeTruthy();
  });

  it("Escape inside a field blurs it and does not leave the view", async () => {
    const { history } = renderView("p3");
    const field = (await screen.findByLabelText("Default branch")) as HTMLInputElement;

    act(() => field.focus());
    expect(document.activeElement).toBe(field);
    fireEvent.keyDown(field, { key: "Escape" });

    // Blurred, and the location is unchanged (a field Escape never navigates).
    expect(document.activeElement).not.toBe(field);
    expect(history.history.at(-1)).toBe(projectIndexingPath("p3"));
  });

  it('"Looks right" dismisses the card without claiming it was saved', async () => {
    const { user } = renderView("p4");

    await user.click(await screen.findByRole("button", { name: "Looks right" }));
    // Honest copy — edits are local-only (no project-config write command exists yet), so the
    // line points at Settings rather than claiming a save that never happened.
    expect(screen.getByText(/Set these anytime in Settings/)).toBeTruthy();
    expect(screen.queryByText(/saved/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Looks right" })).toBeNull();
  });
});

describe("IndexingView — build timeline & completion", () => {
  it("build steps render in production order off the progress channel, spinning then ticking", async () => {
    const { emit } = renderView("m1");
    await waitFor(() => expect(screen.getByText("rennet")).toBeTruthy());

    // Production order: repo-start FIRST (it precedes generation), then stages.
    emit(repoStart);
    await waitFor(() => expect(screen.getByText(/Building rennet/)).toBeTruthy());
    emit(stage("Scanned the working tree", "456 files"));
    await waitFor(() => expect(screen.getByText(/Scanned the working tree/)).toBeTruthy());
    emit(stage("Mapped imports across scopes"));
    await waitFor(() => expect(screen.getByText(/Mapped imports across scopes/)).toBeTruthy());

    // Order preserved; only the newest step spins, the earlier one has ticked.
    const a = stepRow(/Scanned the working tree/).compareDocumentPosition(
      stepRow(/Mapped imports across scopes/),
    );
    expect(a & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(stepRow(/Scanned the working tree/).querySelector(".animate-spin")).toBeNull();
    expect(stepRow(/Mapped imports across scopes/).querySelector(".animate-spin")).toBeTruthy();

    // repo-done renders REAL counts off the wire summary (never scripted text).
    emit({ kind: "repo-done", repo: "rennet", summary: okSummary(456, 1200) });
    await waitFor(() =>
      expect(screen.getByText(/Built rennet · 456 files · 1200 symbols/)).toBeTruthy(),
    );
  });

  it("an all-ok run with a real map reads Context Map Ready with real counts", async () => {
    const { finishWith } = renderView("r1", {
      "project.contextMap": () => contextMapOk(12, 3, 1),
    });
    await waitFor(() => expect(screen.getByText("rennet")).toBeTruthy());

    finishWith([okSummary(456, 1200)]);
    await waitFor(() => expect(screen.getByText("Context Map Ready")).toBeTruthy());
    expect(screen.getByText(/12 scopes · 456 files · 3 confirmed · 1 rejected/)).toBeTruthy();
  });

  it("does NOT claim Context Map Ready while the map read is still in flight", async () => {
    // The regression: `mapUnavailable` is false BOTH when the map is fine and when the
    // read has not answered yet, so the block used to read "Context Map Ready" during
    // loading — asserting a map nobody had confirmed, and retracting it if one never
    // arrived. A pending read is its own state, and it claims nothing.
    const map = deferred<ReturnType<typeof contextMapOk>>();
    const { finishWith } = renderView("pending1", {
      "project.contextMap": () => map.promise,
    });
    await waitFor(() => expect(screen.getByText("rennet")).toBeTruthy());

    finishWith([okSummary(456, 1200)]);
    await waitFor(() =>
      expect(screen.getByText(/Indexing finished — reading the context map/)).toBeTruthy(),
    );
    expect(screen.queryByText("Context Map Ready")).toBeNull();
    // Nothing offers a map that has not been confirmed to exist.
    expect(screen.queryByRole("button", { name: "View Context Map" })).toBeNull();

    // Once it answers, the honest claim lands — with its counts in the same commit, which
    // is why the counts assertion below needs no second wait.
    await act(async () => {
      map.resolve(contextMapOk(12, 3, 1));
    });
    await waitFor(() => expect(screen.getByText("Context Map Ready")).toBeTruthy());
    expect(screen.getByText(/12 scopes · 456 files · 3 confirmed · 1 rejected/)).toBeTruthy();
  });

  it("a run that finished but produced no queryable map does NOT claim Context Map Ready", async () => {
    const { finishWith } = renderView("r2", {
      "project.contextMap": () => ({ status: "absent", reason: "no snapshot yet" }),
    });
    await waitFor(() => expect(screen.getByText("rennet")).toBeTruthy());

    finishWith([okSummary(88, 200)]);
    // The honest completion state: finished, but the map isn't ready — never "Context Map Ready".
    await waitFor(() => expect(screen.getByText(/the context map isn't ready yet/)).toBeTruthy());
    expect(screen.queryByText("Context Map Ready")).toBeNull();
    expect(screen.queryByRole("button", { name: /View Context Map/ })).toBeNull();
    // Rule Zero: a missing map never blocks the reviewer — Start a Review is still offered.
    expect(screen.getByRole("button", { name: /Start a Review/ })).toBeTruthy();
  });

  it("a transport error reads Indexing failed, never Context Map Ready", async () => {
    const { fail } = renderView("f1");
    await waitFor(() => expect(screen.getByText("rennet")).toBeTruthy());

    fail();
    await waitFor(() => expect(screen.getByText("Indexing failed")).toBeTruthy());
    expect(screen.queryByText("Context Map Ready")).toBeNull();
    expect(screen.queryByRole("button", { name: /View Context Map/ })).toBeNull();
    // The sidebar spinner clears even on failure (cleared in the resolution path, always).
    expect(selectProcessingProjectIds(useRennetStore.getState())).not.toContain("f1");
    // Still never blocked.
    expect(screen.getByRole("button", { name: /Start a Review/ })).toBeTruthy();
  });

  it("a run where some repos failed reads partial and names them", async () => {
    const { finishWith } = renderView("pt1", {
      "project.contextMap": () => contextMapOk(5, 0, 0),
    });
    await waitFor(() => expect(screen.getByText("rennet")).toBeTruthy());

    finishWith([okSummary(40, 90), failedSummary("legacy", "clone failed")]);
    await waitFor(() => expect(screen.getByText(/some repositories didn't index/)).toBeTruthy());
    expect(screen.getByText(/Didn't index: legacy/)).toBeTruthy();
    expect(screen.queryByText("Context Map Ready")).toBeNull();
  });

  it("never-a-gate: the map completes and the exits appear with the questionnaire unanswered", async () => {
    const { finishWith, history, user } = renderView("p5", {
      "project.contextMap": () => contextMapOk(3, 1, 0),
    });
    await waitFor(() => expect(screen.getByText("rennet")).toBeTruthy());
    // Resolve project.process WITHOUT ever touching the questionnaire.
    finishWith([okSummary(120, 300)]);

    await waitFor(() => expect(screen.getByText("Context Map Ready")).toBeTruthy());
    // The questionnaire was never answered — it is still offered, not collapsed.
    expect(screen.getByRole("button", { name: "Looks right" })).toBeTruthy();

    // Both exits are live.
    await user.click(screen.getByRole("button", { name: /View Context Map/ }));
    expect(history.history.at(-1)).toBe(projectMapPath("p5"));

    await user.click(screen.getByRole("button", { name: /Start a Review/ }));
    expect(history.history.at(-1)).toBe(newChatPath("p5"));
  });

  it("the Start a Review CTA scrolls itself into view on completion", async () => {
    const scrollSpy = vi.fn();
    const original = Element.prototype.scrollIntoView;
    // happy-dom has no scrollIntoView — install a spy (the view calls it optionally).
    Element.prototype.scrollIntoView = scrollSpy;
    try {
      const { finishWith } = renderView("s1", {
        "project.contextMap": () => contextMapOk(1, 0, 0),
      });
      await waitFor(() => expect(screen.getByText("rennet")).toBeTruthy());
      finishWith([okSummary(10, 20)]);
      await waitFor(() => expect(screen.getByText("Context Map Ready")).toBeTruthy());
      expect(scrollSpy).toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("a late resolution never paints a DIFFERENT project's view (run-identity guard)", async () => {
    // One mounted view, two projects driven through it (wouter re-renders the same instance
    // on a param change). Project A's run resolves AFTER we've navigated to B; its summaries
    // must not land in B's view.
    const history = memoryHistory(projectIndexingPath("A"));
    const runA = deferred<{ repos: ProcessedRepoSummary[] }>();
    const runB = deferred<{ repos: ProcessedRepoSummary[] }>();
    const bridge = new MemoryBridge({
      "projects.list": () => ({ projects: [project("A"), { ...project("B"), id: "B" }] }),
      "project.process": (input) => (input.projectId === "A" ? runA.promise : runB.promise),
      "project.contextMap": () => contextMapOk(99, 0, 0),
    });
    const view = mount(
      <BridgeProvider bridge={bridge}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          <IndexingView projectId="A" />
        </Router>
      </BridgeProvider>,
    );

    await waitFor(() => expect(screen.getByText("indexing")).toBeTruthy());
    // Navigate to B (same component instance, new projectId).
    view.rerender(
      <BridgeProvider bridge={bridge}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          <IndexingView projectId="B" />
        </Router>
      </BridgeProvider>,
    );
    await waitFor(() =>
      expect(selectProcessingProjectIds(useRennetStore.getState())).toContain("B"),
    );

    // A resolves LATE, with A's own summaries.
    act(() => runA.resolve({ repos: [okSummary(500, 900)] }));

    // B's view is untouched — no completion painted, and A's spinner cleared.
    expect(screen.queryByText("Context Map Ready")).toBeNull();
    await waitFor(() =>
      expect(selectProcessingProjectIds(useRennetStore.getState())).not.toContain("A"),
    );
    expect(selectProcessingProjectIds(useRennetStore.getState())).toContain("B");
  });

  it("the sidebar indexing spinner tracks the run — on while in flight, off when it resolves", async () => {
    const history = memoryHistory(projectIndexingPath("side1"));
    const process = deferred<{ repos: ProcessedRepoSummary[] }>();
    const bridge = new MemoryBridge({
      "projects.list": () => ({ projects: [project("side1")] }),
      "project.process": () => process.promise,
    });
    mount(
      <BridgeProvider bridge={bridge}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          <Sidebar />
          <IndexingView projectId="side1" />
        </Router>
      </BridgeProvider>,
    );

    // The run is in flight → the sidebar row spins on "indexing".
    await waitFor(() => expect(screen.getByText("indexing")).toBeTruthy());

    // The run resolves → the spinner clears (the header may read "indexed", the sidebar does not).
    act(() => process.resolve({ repos: [] }));
    await waitFor(() => expect(screen.queryByText("indexing")).toBeNull());
  });

  it("leaving the indexing view does not cancel — the sidebar spinner persists until the run resolves", async () => {
    const history = memoryHistory(projectIndexingPath("side2"));
    const process = deferred<{ repos: ProcessedRepoSummary[] }>();
    const bridge = new MemoryBridge({
      "projects.list": () => ({ projects: [project("side2")] }),
      "project.process": () => process.promise,
    });
    mount(
      <BridgeProvider bridge={bridge}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          <Sidebar />
        </Router>
      </BridgeProvider>,
    );
    const indexing = mount(
      <BridgeProvider bridge={bridge}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          <IndexingView projectId="side2" />
        </Router>
      </BridgeProvider>,
    );

    await waitFor(() => expect(screen.getByText("indexing")).toBeTruthy());

    // Leave the view — the run keeps going (main owns it); the spinner stays on.
    act(() => indexing.unmount());
    expect(screen.getByText("indexing")).toBeTruthy();

    // Only when the run itself resolves does the spinner clear.
    act(() => process.resolve({ repos: [] }));
    await waitFor(() => expect(screen.queryByText("indexing")).toBeNull());
  });
});
