// @vitest-environment happy-dom
//
// The front door (issue #29): the empty projects list IS first run, and the
// add-a-project flow that lives there is the whole onboarding. This mounts the
// real `FrontDoor` over a recording fake `RennetBridge` and drives the WHOLE
// journey — empty state → type + path → worktree config → confirm → the project
// appears — asserting the recorded command inputs (behavioural, not presence).
import type {
  CommandInput,
  DiscoveryResult,
  ProcessedRepoSummary,
  Project,
  ProjectProcessEvent,
  RennetBridge,
} from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, mount, waitFor } from "../test/dom";
import { FrontDoor } from "./front-door";

const discovery: DiscoveryResult = {
  path: "/orbital",
  kind: "repo",
  primaryBranch: "main",
  repos: [{ name: "atlas", path: "/orbital", branches: 3, remote: "github.com/orbital/atlas" }],
};

interface FakeConfig {
  projects?: Project[];
  detected?: { id: string; version: string | null }[];
  chosenPath?: string;
  discovery?: DiscoveryResult;
  /** The live narration events `project.process` streams before it resolves. */
  progressEvents?: ProjectProcessEvent[];
  /** The per-repo summaries `project.process` resolves with. */
  processedRepos?: ProcessedRepoSummary[];
}

function fakeBridge(config: FakeConfig = {}): {
  bridge: RennetBridge;
  calls: { name: string; input: unknown }[];
} {
  const calls: { name: string; input: unknown }[] = [];
  let projects = [...(config.projects ?? [])];
  let progressListener: ((event: ProjectProcessEvent) => void) | undefined;
  const invoke = async (name: string, input: unknown): Promise<unknown> => {
    calls.push({ name, input });
    switch (name) {
      case "projects.list":
        return { projects };
      case "harness.detect":
        return { detected: config.detected ?? [] };
      case "repository.choose":
        return { path: config.chosenPath ?? "/orbital" };
      case "project.discover":
        return { discovery: config.discovery ?? discovery };
      case "projects.add": {
        const added: Project = {
          id: "added-1",
          name: "orbital",
          path: "/orbital",
          kind: "repo",
          repoCount: 1,
          branchCount: 3,
          primaryBranch: (input as CommandInput<"projects.add">).primaryBranch,
          openPath: "/orbital",
          addedAt: "2026-08-09T00:00:00.000Z",
        };
        projects = [...projects, added];
        return { project: added, projects };
      }
      case "project.process": {
        // Stream the configured narration to the live subscriber (registered in the
        // component's effect before this invoke runs), then resolve like main does.
        const repos = config.processedRepos ?? [];
        for (const event of config.progressEvents ?? []) progressListener?.(event);
        progressListener?.({ kind: "done", repos });
        return { repos };
      }
      default:
        return {};
    }
  };
  const onProgress: RennetBridge["onProgress"] = (_commandId, listener) => {
    progressListener = listener;
    return () => {
      progressListener = undefined;
    };
  };
  return { bridge: { invoke: invoke as unknown as RennetBridge["invoke"], onProgress }, calls };
}

describe("FrontDoor — the empty projects list is first run", () => {
  it("renders the add-a-project affordance and the ambient harness-detection line", async () => {
    const { bridge } = fakeBridge({ detected: [{ id: "claude", version: "2.1.0" }] });
    const { container } = mount(<FrontDoor bridge={bridge} onOpenProject={vi.fn()} />);

    await waitFor(() => expect(container.querySelector(".add-card")).not.toBeNull());
    expect(container.querySelector(".add-card-title")?.textContent).toBe("Add a project");
    // The detection line is ambient backlight, felt not ceremonial.
    await waitFor(() => expect(container.querySelector(".harness-line")).not.toBeNull());
    expect(container.querySelector(".harness-line")?.textContent).toContain("Claude");
    expect(container.querySelector(".harness-line")?.textContent).toContain("detected");
  });
});

describe("FrontDoor — the add-a-project flow", () => {
  it("walks type+path → worktree config → confirm, persisting the confirmed choices", async () => {
    const { bridge, calls } = fakeBridge({
      chosenPath: "/orbital",
      processedRepos: [{ repo: "orbital", path: "/orbital", ok: true, files: 12, symbols: 8 }],
    });
    const { container, getByRole } = mount(<FrontDoor bridge={bridge} onOpenProject={vi.fn()} />);

    // Open the flow from the empty-state affordance.
    await waitFor(() => expect(container.querySelector(".add-card")).not.toBeNull());
    fireEvent.click(getByRole("button", { name: /Add a project/ }));

    // Step 1: pick the "Project repo" type, then Browse for a path.
    await waitFor(() => expect(container.querySelector(".type-choice")).not.toBeNull());
    fireEvent.click(getByRole("button", { name: /Project repo/ }));
    fireEvent.click(getByRole("button", { name: "Browse" }));
    await waitFor(() =>
      expect(container.querySelector(".path-field")?.textContent).toContain("/orbital"),
    );

    // Continue runs read-only discovery and lands on step 2.
    fireEvent.click(getByRole("button", { name: /Continue/ }));
    await waitFor(() => expect(container.querySelector(".worktree-rows")).not.toBeNull());
    const discoverCall = calls.find((call) => call.name === "project.discover");
    expect(discoverCall?.input).toMatchObject({ path: "/orbital", kind: "repo" });
    expect(container.querySelector(".worktree-name")?.textContent).toBe("atlas");
    expect(container.querySelector(".worktree-sub")?.textContent).toContain("3 branches");

    // Confirm persists the project from the discovery + toggle choices.
    fireEvent.click(getByRole("button", { name: /Confirm/ }));
    await waitFor(() => expect(calls.some((call) => call.name === "projects.add")).toBe(true));
    const addCall = calls.find((call) => call.name === "projects.add");
    if (!addCall) throw new Error("projects.add was not invoked");
    const addInput = addCall.input as CommandInput<"projects.add">;
    expect(addInput).toMatchObject({ includedRepos: ["atlas"], primaryBranch: "main" });
    expect(addInput.discovery.path).toBe("/orbital");

    // Confirm moves into the processing screen (the initial context dump), which
    // runs the real `project.process` and reaches its done state.
    await waitFor(() => expect(calls.some((call) => call.name === "project.process")).toBe(true));
    await waitFor(() =>
      expect(container.querySelector(".processing[data-phase='done']")).not.toBeNull(),
    );
    expect(container.textContent).toContain("orbital is ready");

    // "Back to projects" closes the flow and the new project shows in the list.
    fireEvent.click(getByRole("button", { name: /Back to projects/ }));
    await waitFor(() => expect(container.querySelector(".project-row")).not.toBeNull());
    expect(container.querySelector(".project-row-name")?.textContent).toBe("orbital");
  });

  it("excludes a de-toggled repo from the confirmed includedRepos set", async () => {
    const twoRepos: DiscoveryResult = {
      path: "/orbital",
      kind: "workspace",
      primaryBranch: "main",
      repos: [
        { name: "atlas", path: "/orbital/atlas", branches: 3 },
        { name: "atlas-docs", path: "/orbital/atlas-docs", branches: 2, note: "docs only" },
      ],
    };
    const { bridge, calls } = fakeBridge({ discovery: twoRepos, chosenPath: "/orbital" });
    const { container, getByRole } = mount(<FrontDoor bridge={bridge} onOpenProject={vi.fn()} />);

    await waitFor(() => expect(container.querySelector(".add-card")).not.toBeNull());
    fireEvent.click(getByRole("button", { name: /Add a project/ }));
    await waitFor(() => expect(container.querySelector(".type-choice")).not.toBeNull());
    fireEvent.click(getByRole("button", { name: "Browse" }));
    await waitFor(() =>
      expect(container.querySelector(".path-field")?.textContent).toContain("/orbital"),
    );
    fireEvent.click(getByRole("button", { name: /Continue/ }));
    await waitFor(() => expect(container.querySelector(".worktree-rows")).not.toBeNull());

    // Everything is on by default; flip atlas-docs OFF, then confirm.
    fireEvent.click(getByRole("switch", { name: "Include atlas-docs" }));
    fireEvent.click(getByRole("button", { name: /Confirm/ }));

    await waitFor(() => expect(calls.some((call) => call.name === "projects.add")).toBe(true));
    const addCall = calls.find((call) => call.name === "projects.add");
    if (!addCall) throw new Error("projects.add was not invoked");
    expect((addCall.input as CommandInput<"projects.add">).includedRepos).toEqual(["atlas"]);
  });
});
