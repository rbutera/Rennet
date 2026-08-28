// @vitest-environment happy-dom
import type { Project, SettingsView } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import { act, mount, waitFor } from "../test/dom";
import { frontDoorBridge, frontDoorHandlers } from "../test/fixtures/front-door";
import { MemoryBridge } from "../test/memory-bridge";
import { RennetRouterApp } from "./app";
import { memoryHistory } from "./history";

describe("RennetRouterApp", () => {
  const project = (id: string, name: string): Project => ({
    id,
    name,
    path: `/code/${name}`,
    kind: "repo",
    repoCount: 1,
    branchCount: 0,
    primaryBranch: "main",
    openPath: `/code/${name}`,
    addedAt: "2026-08-28T00:00:00.000Z",
    source: "local",
  });

  const settings = (overrides: Partial<SettingsView> = {}): SettingsView => ({
    scheme: "system",
    schemeProvenance: {
      layer: "builtin",
      contributions: [{ layer: "builtin", value: "system", effective: true }],
    },
    appearanceMalformed: false,
    projects: [],
    welcome: { completedAt: "2026-08-28T00:00:00.000Z" },
    ...overrides,
  });

  it("shows the full-window welcome only for a fresh zero-project client", async () => {
    const bridge = new MemoryBridge({
      ...frontDoorHandlers(),
      "settings.get": () => settings({ welcome: undefined }),
      "harness.hosts": () => ({ hosts: [] }),
      "forge.hosts": () => ({ hosts: [] }),
    });
    const history = memoryHistory("/"); // "/" redirects to /new-chat
    const { findByText, queryByTestId } = mount(
      <RennetRouterApp bridge={bridge} history={history} />,
    );
    expect(
      await findByText("You stopped writing the code. You still have to answer for it."),
    ).toBeTruthy();
    // The shell is NOT mounted beneath the welcome (D7). A hidden-but-mounted underlay
    // still registered coach anchors and still let the coachmark — which portals to
    // `document.body`, outside the underlay — paint over the wizard.
    expect(queryByTestId("chat-dock-slot")).toBeNull();
  });

  it("shows the focused Add Project entry after a completed welcome has no projects", async () => {
    const { findByText, getByTestId } = mount(
      <RennetRouterApp bridge={frontDoorBridge()} history={memoryHistory("/")} />,
    );
    expect(await findByText("Add a project to begin.")).toBeTruthy();
    expect(getByTestId("chat-dock-slot")).toBeTruthy();
  });

  it("opens bare New Chat on the remembered valid project", async () => {
    const alpha = project("p1", "alpha");
    const beta = project("p2", "beta");
    const remember = vi.fn(() => ({ source: "local" as const, projectId: "p2" }));
    const bridge = new MemoryBridge({
      ...frontDoorHandlers([alpha, beta]),
      "settings.get": () => settings({ navigation: { lastProjectBySource: { local: "p2" } } }),
      "settings.setLastProject": remember,
    });
    const history = memoryHistory("/new-chat");
    const { findByText } = mount(<RennetRouterApp bridge={bridge} history={history} />);
    expect(await findByText("No open branches or pull requests yet.")).toBeTruthy();
    await waitFor(() => expect(history.history.at(-1)).toBe("/new-chat?project=p2"));
    expect(remember).toHaveBeenCalledWith({ source: "local", projectId: "p2" });
  });

  it("recovers a stale remembered project to the first surviving project", async () => {
    const alpha = project("p1", "alpha");
    const remember = vi.fn(() => ({ source: "local" as const, projectId: "p1" }));
    const bridge = new MemoryBridge({
      ...frontDoorHandlers([alpha]),
      "settings.get": () => settings({ navigation: { lastProjectBySource: { local: "removed" } } }),
      "settings.setLastProject": remember,
    });
    const history = memoryHistory("/new-chat");
    const { findByText } = mount(<RennetRouterApp bridge={bridge} history={history} />);
    expect(await findByText("No open branches or pull requests yet.")).toBeTruthy();
    await waitFor(() => expect(history.history.at(-1)).toBe("/new-chat?project=p1"));
  });

  it("chat-dock DOM node survives a settings route round-trip (risk 4)", async () => {
    const history = memoryHistory("/new-chat");
    const { getByTestId, findByText } = mount(
      <RennetRouterApp bridge={frontDoorBridge()} history={history} />,
    );
    await findByText("Add a project to begin.");
    const dockBefore = getByTestId("chat-dock-slot");

    act(() => history.navigate("/settings/appearance"));
    await waitFor(() => expect(document.querySelector('[data-screen="settings"]')).toBeTruthy());

    act(() => history.navigate("/new-chat"));
    await findByText("Add a project to begin.");

    const dockAfter = getByTestId("chat-dock-slot");
    // The SAME DOM node — navigation swapped only the outlet, never the dock slot.
    expect(dockAfter).toBe(dockBefore);
  });

  it("a genuinely missing review renders not-found (the daemon's typed signal)", async () => {
    // The daemon's contract for an unknown reviewId is a `Review not found` rejection
    // (server dispatch.ts). ONLY that maps to not-found — modelled here honestly.
    const bridge = new MemoryBridge({
      ...frontDoorHandlers(),
      "review.load": () => {
        throw new Error("Review not found");
      },
    });
    const history = memoryHistory("/s/does-not-exist");
    const { findByText } = mount(<RennetRouterApp bridge={bridge} history={history} />);
    expect(await findByText("Not found")).toBeTruthy();
  });

  it("a load FAILURE (disconnect / IPC fault) renders an honest error, not a false not-found", async () => {
    // Any rejection that is NOT the missing-review signal is a real error — it must not
    // masquerade as "Nothing here" (finding 5: every failure rendering not-found is a lie).
    const bridge = new MemoryBridge({
      ...frontDoorHandlers(),
      "review.load": () => {
        throw new Error("daemon connection lost");
      },
    });
    const history = memoryHistory("/s/review-1");
    const { findByText } = mount(<RennetRouterApp bridge={bridge} history={history} />);
    expect(await findByText(/Couldn.t open this review/)).toBeTruthy();
    expect(await findByText(/daemon connection lost/)).toBeTruthy();
  });
});
