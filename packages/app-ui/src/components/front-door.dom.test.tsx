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
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { BridgeProvider } from "../data";
import { fireEvent, mount as mountDom, waitFor } from "../test/dom";
import { FrontDoor } from "./front-door";

/** The app root supplies a `BridgeProvider`; these mounts render FrontDoor, which reaches
 *  the seam (its GitHub card reads `github.status` through `useCommand`). Wrapping here keeps every existing
 *  call site as-is — the bridge each test already passes on the root element is the one
 *  the provider carries. */
function mount(ui: ReactElement): ReturnType<typeof mountDom> {
  const { bridge } = ui.props as { bridge: RennetBridge };
  return mountDom(<BridgeProvider bridge={bridge}>{ui}</BridgeProvider>);
}

const discovery: DiscoveryResult = {
  path: "/orbital",
  kind: "repo",
  primaryBranch: "main",
  repos: [{ name: "atlas", path: "/orbital", branches: 3, remote: "github.com/orbital/atlas" }],
  source: "local",
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
      case "fs.listDir": {
        // The in-app directory browser opens on the daemon's home (source-aware project
        // selection): answer with the fixture path so the browse lands there and the flow's
        // path becomes it, exactly as a real daemon's home listing would.
        const requested = (input as { path?: string }).path;
        const path =
          requested && requested.length > 0 ? requested : (config.chosenPath ?? "/orbital");
        return {
          result: { path, home: config.chosenPath ?? "/orbital", parent: "/", entries: [] },
        };
      }
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
          source: "local",
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

    // Step 1: pick the "Project repo" type. The in-app directory browser opens on the daemon's
    // home (the fixture path here), which becomes the flow's selected path — no native picker.
    await waitFor(() => expect(container.querySelector(".type-choice")).not.toBeNull());
    fireEvent.click(getByRole("button", { name: /Project repo/ }));
    await waitFor(() => expect(container.querySelector(".directory-browser")).not.toBeNull());
    await waitFor(() =>
      expect((getByRole("button", { name: /Continue/ }) as HTMLButtonElement).disabled).toBe(false),
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
      source: "local",
    };
    const { bridge, calls } = fakeBridge({ discovery: twoRepos, chosenPath: "/orbital" });
    const { container, getByRole } = mount(<FrontDoor bridge={bridge} onOpenProject={vi.fn()} />);

    await waitFor(() => expect(container.querySelector(".add-card")).not.toBeNull());
    fireEvent.click(getByRole("button", { name: /Add a project/ }));
    await waitFor(() => expect(container.querySelector(".type-choice")).not.toBeNull());
    await waitFor(() =>
      expect((getByRole("button", { name: /Continue/ }) as HTMLButtonElement).disabled).toBe(false),
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

describe("FrontDoor — source switcher in the add flow", () => {
  const sources = [
    { id: "local" as const, label: "Local" },
    { id: "wsl:Ubuntu" as const, label: "WSL: Ubuntu" },
  ];

  it("attaches a non-local source's daemon when its switcher row is selected", async () => {
    const { bridge } = fakeBridge({ chosenPath: "/orbital" });
    const connectSource = vi.fn(async () => ({ switched: true }));
    const { container, getByRole } = mount(
      <FrontDoor
        bridge={bridge}
        sources={sources}
        connectSource={connectSource}
        onOpenProject={vi.fn()}
      />,
    );

    await waitFor(() => expect(container.querySelector(".add-card")).not.toBeNull());
    fireEvent.click(getByRole("button", { name: /Add a project/ }));
    await waitFor(() => expect(container.querySelector(".source-switcher")).not.toBeNull());
    // Selecting the WSL row asks the shell to attach that source's daemon, carrying the
    // flow's default kind ("repo"). switched:true remounts the app — this instance stops.
    fireEvent.click(getByRole("button", { name: /WSL: Ubuntu/ }));
    await waitFor(() => expect(connectSource).toHaveBeenCalledTimes(1));
    // A plain switcher select carries no browse path (only a recent restore does).
    expect(connectSource).toHaveBeenCalledWith("wsl:Ubuntu", "repo", undefined);
  });

  it("carries the selected source into discover on a local add (switched:false)", async () => {
    const { bridge, calls } = fakeBridge({
      chosenPath: "/orbital",
      processedRepos: [{ repo: "orbital", path: "/orbital", ok: true, files: 3, symbols: 2 }],
    });
    const { container, getByRole } = mount(
      <FrontDoor bridge={bridge} sources={sources} onOpenProject={vi.fn()} />,
    );

    await waitFor(() => expect(container.querySelector(".add-card")).not.toBeNull());
    fireEvent.click(getByRole("button", { name: /Add a project/ }));
    await waitFor(() => expect(container.querySelector(".type-choice")).not.toBeNull());
    fireEvent.click(getByRole("button", { name: /Project repo/ }));
    await waitFor(() =>
      expect((getByRole("button", { name: /Continue/ }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(getByRole("button", { name: /Continue/ }));

    // The browsed path is granted then discovered on the attached (local) daemon, tagged local.
    await waitFor(() => expect(container.querySelector(".worktree-rows")).not.toBeNull());
    expect(calls.find((call) => call.name === "project.discover")?.input).toMatchObject({
      path: "/orbital",
      kind: "repo",
      source: "local",
    });
    fireEvent.click(getByRole("button", { name: /Confirm/ }));
    await waitFor(() => expect(calls.some((call) => call.name === "projects.add")).toBe(true));
    // The source rides through on the DISCOVERY (the one authoritative field), not a
    // redundant top-level `source` — dropped so a caller can't disagree with it.
    expect(calls.find((call) => call.name === "projects.add")?.input).toMatchObject({
      discovery: { source: "local" },
    });
  });

  it("restores the browse step from a pending source browse, once", async () => {
    const { bridge } = fakeBridge({ chosenPath: "/home/rai" });
    const onConsumed = vi.fn();
    const { container, getByRole } = mount(
      <FrontDoor
        bridge={bridge}
        sources={sources}
        pendingSourceBrowse={{ source: "wsl:Ubuntu", kind: "workspace" }}
        onPendingSourceBrowseConsumed={onConsumed}
        onOpenProject={vi.fn()}
      />,
    );

    // The freshly mounted front door re-opens the add flow at the browse step with the
    // restored source selected, and tells the host to clear the pending browse exactly once.
    await waitFor(() => expect(container.querySelector(".directory-browser")).not.toBeNull());
    expect(container.querySelector(".source-switcher")).not.toBeNull();
    expect(getByRole("button", { name: /WSL: Ubuntu/ }).getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(onConsumed).toHaveBeenCalledTimes(1));
  });

  it("re-selects a recent's SOURCE (not just its path) into the flow", async () => {
    // A recent project that lives on a WSL source: clicking it must point the flow at that
    // source, not just its path — `recentPaths` carries `project.source` for exactly this.
    const wslProject: Project = {
      id: "p1",
      name: "orbital",
      path: "/home/rai/orbital",
      kind: "repo",
      repoCount: 1,
      branchCount: 2,
      primaryBranch: "main",
      openPath: "/home/rai/orbital",
      addedAt: "2026-08-09T00:00:00.000Z",
      source: "wsl:Ubuntu",
    };
    const { bridge } = fakeBridge({ projects: [wslProject], chosenPath: "/home/rai" });
    const { container, getByRole } = mount(
      <FrontDoor bridge={bridge} sources={sources} onOpenProject={vi.fn()} />,
    );

    // The projects list is populated (one recent), so open the add flow from its add row.
    await waitFor(() => expect(container.querySelector(".project-rows")).not.toBeNull());
    fireEvent.click(getByRole("button", { name: /Add a project/ }));
    // The flow opens on Local; the recent for the WSL project is offered.
    await waitFor(() => expect(container.querySelector(".recent-row")).not.toBeNull());
    expect(getByRole("button", { name: /^Local/ }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(container.querySelector(".recent-row") as HTMLElement);

    // The switcher now shows the recent's source selected — proof the source was restored.
    expect(getByRole("button", { name: /WSL: Ubuntu/ }).getAttribute("aria-pressed")).toBe("true");
    expect(getByRole("button", { name: /^Local/ }).getAttribute("aria-pressed")).toBe("false");
  });

  it("ATTACHES a non-local recent's daemon (not just relabels the source)", async () => {
    // The I2 defect: a non-local recent set the source LABEL but never asked the shell to
    // attach that source's daemon, so the browse then ran on the wrong (local) daemon. The
    // recent must route through `connectSource` exactly like the switcher, carrying its path.
    const wslProject: Project = {
      id: "p1",
      name: "orbital",
      path: "/home/rai/orbital",
      kind: "repo",
      repoCount: 1,
      branchCount: 2,
      primaryBranch: "main",
      openPath: "/home/rai/orbital",
      addedAt: "2026-08-09T00:00:00.000Z",
      source: "wsl:Ubuntu",
    };
    const { bridge } = fakeBridge({ projects: [wslProject], chosenPath: "/home/rai" });
    const connectSource = vi.fn(async () => ({ switched: true }));
    const { container, getByRole } = mount(
      <FrontDoor
        bridge={bridge}
        sources={sources}
        connectSource={connectSource}
        onOpenProject={vi.fn()}
      />,
    );

    await waitFor(() => expect(container.querySelector(".project-rows")).not.toBeNull());
    fireEvent.click(getByRole("button", { name: /Add a project/ }));
    await waitFor(() => expect(container.querySelector(".recent-row")).not.toBeNull());

    fireEvent.click(container.querySelector(".recent-row") as HTMLElement);

    // The recent attached its OWN daemon, carrying its kind + path across the switch.
    await waitFor(() => expect(connectSource).toHaveBeenCalledTimes(1));
    expect(connectSource).toHaveBeenCalledWith("wsl:Ubuntu", "repo", "/home/rai/orbital");
  });

  it("completes a pending add on the distro daemon exactly once, then clears it", async () => {
    const { bridge, calls } = fakeBridge({
      processedRepos: [
        { repo: "orbital", path: "/home/rai/orbital", ok: true, files: 5, symbols: 4 },
      ],
    });
    const onPendingAddConsumed = vi.fn();
    const logWslConnect = vi.fn();
    const { container } = mount(
      <FrontDoor
        bridge={bridge}
        pendingAddPath={{ path: "/home/rai/orbital", kind: "workspace" }}
        onPendingAddConsumed={onPendingAddConsumed}
        logWslConnect={logWslConnect}
        onOpenProject={vi.fn()}
      />,
    );

    // The distro-native path is discovered + added without any user interaction.
    await waitFor(() => expect(calls.some((call) => call.name === "projects.add")).toBe(true));
    const discoverCall = calls.find((call) => call.name === "project.discover");
    expect(discoverCall?.input).toMatchObject({ path: "/home/rai/orbital", kind: "workspace" });
    expect(calls.filter((call) => call.name === "project.discover")).toHaveLength(1);
    // The completion is traced and the host is told to clear the pending path.
    await waitFor(() => expect(onPendingAddConsumed).toHaveBeenCalledTimes(1));
    expect(logWslConnect).toHaveBeenCalledWith(
      expect.objectContaining({ event: "add", path: "/home/rai/orbital" }),
    );
    // It lands in the same processing step a local add reaches.
    await waitFor(() => expect(container.querySelector(".processing")).not.toBeNull());
  });

  it("defaults a FRESH add flow's source to the attached daemon (activeSource), not always Local (F1)", async () => {
    const { bridge } = fakeBridge({ chosenPath: "/home/rai" });
    const { container, getByRole } = mount(
      <FrontDoor
        bridge={bridge}
        sources={sources}
        activeSource="wsl:Ubuntu"
        onOpenProject={vi.fn()}
      />,
    );

    await waitFor(() => expect(container.querySelector(".add-card")).not.toBeNull());
    fireEvent.click(getByRole("button", { name: /Add a project/ }));
    await waitFor(() => expect(container.querySelector(".source-switcher")).not.toBeNull());
    // The flow (and the switcher's selection) must agree with the daemon actually attached.
    expect(getByRole("button", { name: /WSL: Ubuntu/ }).getAttribute("aria-pressed")).toBe("true");
    expect(getByRole("button", { name: /^Local/ }).getAttribute("aria-pressed")).toBe("false");
  });

  it("navigates the browser to a SAME-source recent's directory, shown === submitted (F4)", async () => {
    const localProject: Project = {
      id: "p1",
      name: "orbital",
      path: "/home/rai/orbital",
      kind: "repo",
      repoCount: 1,
      branchCount: 2,
      primaryBranch: "main",
      openPath: "/home/rai/orbital",
      addedAt: "2026-08-09T00:00:00.000Z",
      source: "local",
    };
    const { bridge, calls } = fakeBridge({ projects: [localProject], chosenPath: "/home/rai" });
    const { container, getByRole } = mount(
      <FrontDoor bridge={bridge} sources={sources} onOpenProject={vi.fn()} />,
    );

    await waitFor(() => expect(container.querySelector(".project-rows")).not.toBeNull());
    fireEvent.click(getByRole("button", { name: /Add a project/ }));
    await waitFor(() => expect(container.querySelector(".recent-row")).not.toBeNull());
    // The flow opened on Local (same source as the recent), browser at home /home/rai.
    fireEvent.click(container.querySelector(".recent-row") as HTMLElement);

    // A same-source recent must make the browser NAVIGATE to its directory (a reload), not just
    // relabel — proven by an fs.listDir load for the recent's path. Without the reload token the
    // browser would keep showing home while Continue submitted /home/rai/orbital.
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.name === "fs.listDir" &&
            (call.input as { path?: string }).path === "/home/rai/orbital",
        ),
      ).toBe(true),
    );
  });

  it("disables Continue when the typed path is invalid (F5)", async () => {
    // A bridge whose fs.listDir REJECTS a bad path (a real daemon does; the shared fake always
    // echoes) — so a typed nonexistent path surfaces an error and must NOT stay submittable.
    const invoke = async (name: string, input: unknown): Promise<unknown> => {
      if (name === "projects.list") return { projects: [] };
      if (name === "harness.detect") return { detected: [] };
      if (name === "repository.choose") return { path: "/home/rai" };
      if (name === "fs.listDir") {
        const requested = (input as { path?: string }).path;
        if (requested && requested.length > 0 && requested !== "/home/rai") {
          throw new Error("No such directory");
        }
        return { result: { path: "/home/rai", home: "/home/rai", parent: "/", entries: [] } };
      }
      return {};
    };
    const bridge = { invoke: invoke as unknown as RennetBridge["invoke"] } as RennetBridge;
    const { container, getByRole } = mount(<FrontDoor bridge={bridge} onOpenProject={vi.fn()} />);

    await waitFor(() => expect(container.querySelector(".add-card")).not.toBeNull());
    fireEvent.click(getByRole("button", { name: /Add a project/ }));
    await waitFor(() => expect(container.querySelector(".directory-browser")).not.toBeNull());
    // The home listing loaded, so Continue is enabled.
    await waitFor(() =>
      expect((getByRole("button", { name: /Continue/ }) as HTMLButtonElement).disabled).toBe(false),
    );

    const pathBar = getByRole("textbox", { name: "Directory path" }) as HTMLInputElement;
    fireEvent.change(pathBar, { target: { value: "/nope" } });
    fireEvent.keyDown(pathBar, { key: "Enter" });

    await waitFor(() => expect(container.querySelector(".directory-browser-error")).not.toBeNull());
    // The invalid path invalidated the selection — Continue is disabled (SPEC).
    expect((getByRole("button", { name: /Continue/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
