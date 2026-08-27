// @vitest-environment happy-dom
//
// The project indexing view (C12 cluster 3: scout phase + questionnaire) over a
// MemoryBridge: the scout narration rides the REAL `project.process` `onProgress`
// channel (emitted by the test, never a timer), the questionnaire prefills with honest
// provenance the instant the scout returns, Escape inside a field blurs it rather than
// leaving, and — the never-a-gate positive control — the map completes and its exits
// appear with the questionnaire left untouched.
import type { Project, ProjectProcessEvent } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Router } from "wouter";
import { BridgeProvider } from "../../data";
import { memoryHistory } from "../../routes/history";
import { newChatPath, projectIndexingPath, projectMapPath } from "../../routes/url";
import { useRennetStore } from "../../store";
import { act, cleanup, fireEvent, mount, screen, waitFor } from "../../test/dom";
import { MemoryBridge, type MemoryBridgeHandlers } from "../../test/memory-bridge";
import { IndexingView } from "./indexing-view";

afterEach(() => {
  cleanup();
  useRennetStore.setState((s) => ({ ui: { ...s.ui, openDialogs: [] } }));
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

/** A promise with an exposed resolver, to hold `project.process` in flight. */
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Mount the view at its route, capturing the commandId the view minted for
 *  `project.process` so the test can drive its `onProgress` channel. */
function renderView(id: string, extra: MemoryBridgeHandlers = {}) {
  const history = memoryHistory(projectIndexingPath(id));
  const process = deferred<{ repos: [] }>();
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
  const finish = () => act(() => process.resolve({ repos: [] }));
  return { ...view, history, emit, finish, commandIdRef: () => commandId };
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

describe("IndexingView — scout + questionnaire", () => {
  it("scout steps appear, spin, then tick in order as events arrive", async () => {
    const { emit, container } = renderView("p1");
    // Wait for the process handler to run so the onProgress commandId is captured.
    await waitFor(() => expect(screen.getByText("rennet")).toBeTruthy());

    emit(stage("Read the git remotes", "github.com origin"));
    await waitFor(() => expect(screen.getByText(/Read the git remotes/)).toBeTruthy());
    // The only in-flight step spins.
    expect(stepRow(/Read the git remotes/).querySelector(".animate-spin")).toBeTruthy();

    emit(stage("Checked for tracker markers and CI config"));
    await waitFor(() => expect(screen.getByText(/Checked for tracker markers/)).toBeTruthy());
    // The earlier step has ticked (no spinner); the newest one spins.
    expect(stepRow(/Read the git remotes/).querySelector(".animate-spin")).toBeNull();
    expect(stepRow(/Checked for tracker markers/).querySelector(".animate-spin")).toBeTruthy();

    // Ordering is preserved in the DOM.
    const texts = [...container.querySelectorAll("span")].map((s) => s.textContent ?? "");
    const a = texts.findIndex((t) => t.includes("Read the git remotes"));
    const b = texts.findIndex((t) => t.includes("Checked for tracker markers"));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
  });

  it("the questionnaire prefills with honest provenance the instant the scout returns", async () => {
    const { emit } = renderView("p2");
    await waitFor(() => expect(screen.getByText("rennet")).toBeTruthy());

    // No questionnaire while still scouting.
    emit(stage("Read the git remotes", "github.com origin"));
    expect(screen.queryByText(/does this look right/)).toBeNull();

    // repo-start = scout returned → the questionnaire and the capstone appear.
    emit(repoStart);
    await waitFor(() => expect(screen.getByText(/does this look right/)).toBeTruthy());

    // Default branch prefilled from the REAL project; tracker detected from the remote.
    expect((screen.getByLabelText("Default branch") as HTMLInputElement).value).toBe("trunk");
    // tracker + branch are detected (real signals); worktrees/gate/logo are honest guesses.
    expect(screen.getAllByText("detected")).toHaveLength(2);
    expect(screen.getAllByText("guessed")).toHaveLength(3);
    expect(screen.getByText(/Scout returned · 2 detected · 3 guessed/)).toBeTruthy();
  });

  it("Escape inside a field blurs it and does not leave the view", async () => {
    const { emit, history } = renderView("p3");
    await waitFor(() => expect(screen.getByText("rennet")).toBeTruthy());
    emit(repoStart);
    const field = (await screen.findByLabelText("Default branch")) as HTMLInputElement;

    act(() => field.focus());
    expect(document.activeElement).toBe(field);
    fireEvent.keyDown(field, { key: "Escape" });

    // Blurred, and the location is unchanged (a field Escape never navigates).
    expect(document.activeElement).not.toBe(field);
    expect(history.history.at(-1)).toBe(projectIndexingPath("p3"));
  });

  it('"Looks right" collapses the questionnaire to the saved confirmation line', async () => {
    const { emit, user } = renderView("p4");
    await waitFor(() => expect(screen.getByText("rennet")).toBeTruthy());
    emit(repoStart);

    await user.click(await screen.findByRole("button", { name: "Looks right" }));
    expect(screen.getByText(/Project setup saved/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Looks right" })).toBeNull();
  });

  it("never-a-gate: the map completes and the exits appear with the questionnaire unanswered", async () => {
    const { emit, finish, history, user } = renderView("p5");
    await waitFor(() => expect(screen.getByText("rennet")).toBeTruthy());
    emit(stage("Read the git remotes", "github.com origin"));
    emit(repoStart);
    // Resolve project.process WITHOUT ever touching the questionnaire.
    finish();

    await waitFor(() => expect(screen.getByText("Context Map Ready")).toBeTruthy());
    // The questionnaire was never answered — it is still offered, not collapsed.
    expect(screen.getByRole("button", { name: "Looks right" })).toBeTruthy();

    // Both exits are live.
    await user.click(screen.getByRole("button", { name: /View Context Map/ }));
    expect(history.history.at(-1)).toBe(projectMapPath("p5"));

    await user.click(screen.getByRole("button", { name: /Start a Review/ }));
    expect(history.history.at(-1)).toBe(newChatPath("p5"));
  });
});
