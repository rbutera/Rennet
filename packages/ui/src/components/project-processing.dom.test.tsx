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
  { kind: "stage", repo: "orbital", stage: "resolve", note: "Finding the default branch", detail: "main" },
  { kind: "stage", repo: "orbital", stage: "tree", note: "Reading the file tree", detail: "412 files" },
  { kind: "stage", repo: "orbital", stage: "symbols", note: "Extracting symbols & references", detail: "88 files to parse" },
  { kind: "stage", repo: "orbital", stage: "build", note: "Building the repo map" },
  {
    kind: "repo-done",
    repo: "orbital",
    summary: { repo: "orbital", path: "/orbital", ok: true, files: 412, symbols: 260, references: 900 },
  },
];

describe("ProjectProcessing — the initial context dump with live narration", () => {
  it("renders the real streamed stages as narration, then a done summary with real counts", async () => {
    const { bridge, calls } = fakeBridge({
      events: singleRepoRun,
      repos: [{ repo: "orbital", path: "/orbital", ok: true, files: 412, symbols: 260, references: 900 }],
    });
    const onOpen = vi.fn();
    const { container, getByRole } = mount(
      <ProjectProcessing bridge={bridge} project={project} onDone={vi.fn()} onOpen={onOpen} />,
    );

    // It invoked the real command with a commandId.
    await waitFor(() => expect(calls.some((call) => call.name === "project.process")).toBe(true));
    const call = calls.find((entry) => entry.name === "project.process");
    expect((call?.input as { projectId: string }).projectId).toBe("p1");
    expect((call?.input as { commandId?: string }).commandId).toBeTruthy();

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

  it("streams a workspace's repos separately and marks a failed repo softly", async () => {
    const events: ProjectProcessEvent[] = [
      { kind: "repo-start", repo: "atlas", index: 1, total: 2 },
      { kind: "stage", repo: "atlas", stage: "tree", note: "Reading the file tree", detail: "10 files" },
      {
        kind: "repo-done",
        repo: "atlas",
        summary: { repo: "atlas", path: "/ws/atlas", ok: true, files: 10, symbols: 4, references: 6 },
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
    const { container } = mount(
      <ProjectProcessing bridge={bridge} project={project} onDone={vi.fn()} onOpen={vi.fn()} />,
    );

    await waitFor(() =>
      expect(container.querySelector(".processing[data-phase='done']")).not.toBeNull(),
    );
    // No narration trail, but the done summary still reads from the resolved value.
    expect(container.querySelector(".processing-step")).toBeNull();
    expect(container.textContent).toContain("orbital is ready");
    expect(container.textContent).toContain("5 files mapped");
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
});
