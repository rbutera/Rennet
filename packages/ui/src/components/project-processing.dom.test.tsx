// @vitest-environment happy-dom
//
// The processing screen (issue #29, wireframe #2): the initial context dump. This
// mounts the real `ProjectProcessing` over a recording fake bridge and asserts the
// live narration is driven by REAL streamed events (not scripted text), that the
// done state surfaces the real per-repo counts, and that the actions fire. It also
// pins the graceful degradation when the bridge has no push channel.
import type {
  ProcessedRepoSummary,
  Project,
  ProjectProcessEvent,
  RennetBridge,
} from "@rennet/protocol";
import { parseCommandInput } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, mount, waitFor } from "../test/dom";
import { ProjectProcessing } from "./project-processing";

const project: Project = {
  id: "p1",
  name: "orbital",
  path: "/orbital",
  kind: "repo",
  repoCount: 1,
  branchCount: 3,
  primaryBranch: "main",
  openPath: "/orbital",
  addedAt: "2026-08-11T00:00:00.000Z",
};

interface FakeConfig {
  events?: ProjectProcessEvent[];
  repos?: ProcessedRepoSummary[];
  /** Omit the push channel entirely (degraded bridge). */
  noProgress?: boolean;
  /** Reject the command (failed to start). */
  fail?: string;
}

function fakeBridge(config: FakeConfig = {}): {
  bridge: RennetBridge;
  calls: { name: string; input: unknown }[];
} {
  const calls: { name: string; input: unknown }[] = [];
  let listener: ((event: ProjectProcessEvent) => void) | undefined;
  const invoke = async (name: string, input: unknown): Promise<unknown> => {
    calls.push({ name, input });
    if (name !== "project.process") return {};
    if (config.fail) throw new Error(config.fail);
    const repos = config.repos ?? [];
    for (const event of config.events ?? []) listener?.(event);
    listener?.({ kind: "done", repos });
    return { repos };
  };
  const bridge: RennetBridge = { invoke: invoke as unknown as RennetBridge["invoke"] };
  if (!config.noProgress) {
    bridge.onProgress = (_commandId, cb) => {
      listener = cb;
      return () => {
        listener = undefined;
      };
    };
  }
  return { bridge, calls };
}

const singleRepoRun: ProjectProcessEvent[] = [
  { kind: "repo-start", repo: "orbital", index: 1, total: 1 },
  {
    kind: "stage",
    repo: "orbital",
    stage: "resolve",
    note: "Finding the default branch",
    detail: "main",
  },
  {
    kind: "stage",
    repo: "orbital",
    stage: "tree",
    note: "Reading the file tree",
    detail: "412 files",
  },
  {
    kind: "stage",
    repo: "orbital",
    stage: "symbols",
    note: "Extracting symbols & references",
    detail: "88 files to parse",
  },
  { kind: "stage", repo: "orbital", stage: "build", note: "Building the repo map" },
  {
    kind: "repo-done",
    repo: "orbital",
    summary: {
      repo: "orbital",
      path: "/orbital",
      ok: true,
      files: 412,
      symbols: 260,
      references: 900,
    },
  },
];

describe("ProjectProcessing — the initial context dump with live narration", () => {
  it("renders the real streamed stages as narration, then a done summary with real counts", async () => {
    const { bridge, calls } = fakeBridge({
      events: singleRepoRun,
      repos: [
        { repo: "orbital", path: "/orbital", ok: true, files: 412, symbols: 260, references: 900 },
      ],
    });
    const onOpen = vi.fn();
    const { container, getByRole } = mount(
      <ProjectProcessing bridge={bridge} project={project} onDone={vi.fn()} onOpen={onOpen} />,
    );

    // It invoked the real command with a commandId.
    await waitFor(() => expect(calls.some((call) => call.name === "project.process")).toBe(true));
    const call = calls.find((entry) => entry.name === "project.process");
    if (!call) throw new Error("project.process was not invoked");
    const processInput = call.input as { projectId: string; commandId?: string };
    expect(processInput.projectId).toBe("p1");
    expect(processInput.commandId).toBeTypeOf("string");

    // The narration trail shows the REAL stage notes + details that were streamed.
    await waitFor(() =>
      expect(container.querySelector(".processing[data-phase='done']")).not.toBeNull(),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Reading the file tree");
    expect(text).toContain("412 files");
    expect(text).toContain("Extracting symbols & references");
    expect(text).toContain("Building the repo map");

    // Done: the completion line carries the real snapshot totals.
    expect(text).toContain("orbital is ready");
    expect(text).toContain("412 files mapped");
    expect(text).toContain("260 symbols indexed");

    // "Open orbital" fires the open callback.
    fireEvent.click(getByRole("button", { name: /Open orbital/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("uses one parser-valid command UUID for a non-UUID project id across remounts", async () => {
    const first = fakeBridge({ noProgress: true });
    const firstMount = mount(
      <ProjectProcessing
        bridge={first.bridge}
        project={project}
        onDone={vi.fn()}
        onOpen={vi.fn()}
      />,
    );
    await waitFor(() => expect(first.calls).toHaveLength(1));
    firstMount.unmount();

    const second = fakeBridge({ noProgress: true });
    mount(
      <ProjectProcessing
        bridge={second.bridge}
        project={project}
        onDone={vi.fn()}
        onOpen={vi.fn()}
      />,
    );
    await waitFor(() => expect(second.calls).toHaveLength(1));

    const firstInput = parseCommandInput("project.process", first.calls[0]?.input);
    const secondInput = parseCommandInput("project.process", second.calls[0]?.input);
    expect(firstInput.projectId).toBe("p1");
    expect(secondInput.commandId).toBe(firstInput.commandId);
  });

  it("renders the live running state from a deferred bridge", async () => {
    let listener: ((event: ProjectProcessEvent) => void) | undefined;
    let finish: ((value: { repos: ProcessedRepoSummary[] }) => void) | undefined;
    const result = new Promise<{ repos: ProcessedRepoSummary[] }>((resolve) => {
      finish = resolve;
    });
    const bridge: RennetBridge = {
      invoke: ((_name: string, input: unknown) => {
        parseCommandInput("project.process", input);
        return result;
      }) as RennetBridge["invoke"],
      onProgress: (_commandId, next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    };
    const workspace: Project = { ...project, name: "ws", kind: "workspace", repoCount: 2 };
    const { container } = mount(
      <ProjectProcessing bridge={bridge} project={workspace} onDone={vi.fn()} onOpen={vi.fn()} />,
    );

    await waitFor(() => expect(listener).toBeTypeOf("function"));
    listener?.({ kind: "repo-start", repo: "atlas-docs", index: 2, total: 2 });
    listener?.({
      kind: "stage",
      repo: "atlas-docs",
      stage: "resolve",
      note: "Finding the default branch",
      detail: "main",
    });
    listener?.({
      kind: "stage",
      repo: "atlas-docs",
      stage: "tree",
      note: "Reading the file tree",
      detail: "12 files",
    });

    await waitFor(() => expect(container.querySelectorAll(".processing-step")).toHaveLength(2));
    const steps = container.querySelectorAll(".processing-step");
    expect(steps[0]?.classList.contains("is-active")).toBe(false);
    expect(steps[0]?.querySelector("svg")).not.toBeNull();
    expect(steps[1]?.classList.contains("is-active")).toBe(true);
    expect(steps[1]?.querySelector(".processing-dot")).not.toBeNull();
    expect(container.querySelector(".processing-headline")?.textContent).toContain(
      "Reading the file tree · 12 files",
    );
    expect(container.querySelector(".processing-sub")?.textContent).toBe(
      "atlas-docs — repo 2 of 2",
    );

    finish?.({ repos: [] });
  });

  it("wires a landed project artifact through the real processing consumer", async () => {
    const events: ProjectProcessEvent[] = [
      { kind: "repo-start", repo: "orbital", index: 1, total: 1 },
      {
        kind: "repo-done",
        repo: "orbital",
        summary: { repo: "orbital", path: "/orbital", ok: true, files: 5, symbols: 3 },
        artifact: { kind: "project", projectId: "p1" },
      },
    ];
    const { bridge } = fakeBridge({
      events,
      repos: [{ repo: "orbital", path: "/orbital", ok: true, files: 5, symbols: 3 }],
    });
    const onOpen = vi.fn();
    const { getByRole } = mount(
      <ProjectProcessing bridge={bridge} project={project} onDone={vi.fn()} onOpen={onOpen} />,
    );

    const landed = await waitFor(() => getByRole("button", { name: "orbital" }));
    fireEvent.click(landed);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("streams a workspace's repos separately and marks a failed repo softly", async () => {
    const events: ProjectProcessEvent[] = [
      { kind: "repo-start", repo: "atlas", index: 1, total: 2 },
      {
        kind: "stage",
        repo: "atlas",
        stage: "tree",
        note: "Reading the file tree",
        detail: "10 files",
      },
      {
        kind: "repo-done",
        repo: "atlas",
        summary: {
          repo: "atlas",
          path: "/ws/atlas",
          ok: true,
          files: 10,
          symbols: 4,
          references: 6,
        },
      },
      { kind: "repo-start", repo: "atlas-docs", index: 2, total: 2 },
      { kind: "repo-error", repo: "atlas-docs", message: "not a git repository" },
    ];
    const { bridge } = fakeBridge({
      events,
      repos: [
        { repo: "atlas", path: "/ws/atlas", ok: true, files: 10, symbols: 4, references: 6 },
        { repo: "atlas-docs", path: "/ws/atlas-docs", ok: false, error: "not a git repository" },
      ],
    });
    const workspace: Project = { ...project, name: "ws", kind: "workspace", repoCount: 2 };
    const { container } = mount(
      <ProjectProcessing bridge={bridge} project={workspace} onDone={vi.fn()} onOpen={vi.fn()} />,
    );

    await waitFor(() =>
      expect(container.querySelector(".processing[data-phase='done']")).not.toBeNull(),
    );
    // Two distinct repo blocks, one done, one soft-errored (never a thrown crash).
    const blocks = container.querySelectorAll(".processing-repo");
    expect(blocks.length).toBe(2);
    expect(container.querySelector(".processing-repo[data-state='error']")).not.toBeNull();
    const text = container.textContent ?? "";
    expect(text).toContain("not a git repository");
    // The done summary counts the ok repos and names the one that could not be read.
    expect(text).toContain("could not be read");
  });

  it("degrades to a calm done summary when the bridge has no push channel", async () => {
    const { bridge } = fakeBridge({
      noProgress: true,
      repos: [{ repo: "orbital", path: "/orbital", ok: true, files: 5, symbols: 3 }],
    });
    const onOpen = vi.fn();
    const { container, getByRole } = mount(
      <ProjectProcessing bridge={bridge} project={project} onDone={vi.fn()} onOpen={onOpen} />,
    );

    await waitFor(() =>
      expect(container.querySelector(".processing[data-phase='done']")).not.toBeNull(),
    );
    // No narration trail, but the done summary still reads from the resolved value.
    expect(container.querySelector(".processing-step")).toBeNull();
    expect(container.textContent).toContain("orbital is ready");
    expect(container.textContent).toContain("5 files mapped");
    fireEvent.click(getByRole("button", { name: "orbital" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("shows a legible failure when the command cannot start", async () => {
    const onDone = vi.fn();
    const { bridge } = fakeBridge({ fail: "the command router is not ready" });
    const { container, getByRole } = mount(
      <ProjectProcessing bridge={bridge} project={project} onDone={onDone} onOpen={vi.fn()} />,
    );

    await waitFor(() => expect(container.querySelector(".processing-failed")).not.toBeNull());
    expect(container.textContent).toContain("the command router is not ready");
    fireEvent.click(getByRole("button", { name: /Back to projects/ }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("renders a FAILED completion (no 'ready', no Open) when every repo failed", async () => {
    // The command fulfilled, but every repo summary is ok:false — a completely
    // failed context dump must NOT read as success.
    const { bridge, calls } = fakeBridge({
      events: [
        { kind: "repo-start", repo: "orbital", index: 1, total: 1 },
        { kind: "repo-error", repo: "orbital", message: "not a git repository" },
      ],
      repos: [{ repo: "orbital", path: "/orbital", ok: false, error: "not a git repository" }],
    });
    const onOpen = vi.fn();
    const { container, queryByRole } = mount(
      <ProjectProcessing bridge={bridge} project={project} onDone={vi.fn()} onOpen={onOpen} />,
    );

    await waitFor(() => expect(calls.some((call) => call.name === "project.process")).toBe(true));
    await waitFor(() =>
      expect(container.querySelector(".processing[data-outcome='failed']")).not.toBeNull(),
    );
    const text = container.textContent ?? "";
    expect(text).not.toContain("is ready");
    expect(text).toContain("Couldn't process orbital");
    expect(text).toContain("could not be read");
    // No Open affordance on a failed dump; Back to projects remains.
    expect(queryByRole("button", { name: /Open/ })).toBeNull();
    expect(queryByRole("button", { name: /Back to projects/ })).not.toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("still succeeds (Open enabled) when a workspace has at least one good repo", async () => {
    const { bridge } = fakeBridge({
      repos: [
        { repo: "atlas", path: "/ws/atlas", ok: true, files: 10, symbols: 4 },
        { repo: "atlas-docs", path: "/ws/atlas-docs", ok: false, error: "not a git repository" },
      ],
    });
    const workspace: Project = { ...project, name: "ws", kind: "workspace", repoCount: 2 };
    const { container, queryByRole } = mount(
      <ProjectProcessing bridge={bridge} project={workspace} onDone={vi.fn()} onOpen={vi.fn()} />,
    );

    await waitFor(() =>
      expect(container.querySelector(".processing[data-outcome='ok']")).not.toBeNull(),
    );
    expect(container.textContent).toContain("ws is ready");
    expect(queryByRole("button", { name: /Open ws/ })).not.toBeNull();
  });
});
