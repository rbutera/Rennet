// @vitest-environment happy-dom
//
// The ⌘P/⌘K command menu (INVENTORY §9) over a MemoryBridge: it opens from the store,
// fuzzy-filters, shows a group label beside each title, states an empty result, runs an
// entry on select (closing + navigating), and defaults to a different view per mode.
import type { Project } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Router } from "wouter";
import { BridgeProvider } from "../data";
import { memoryHistory } from "../routes/history";
import { useRennetStore } from "../store";
import { act, cleanup, fireEvent, mount, screen, waitFor } from "../test/dom";
import { frontDoorHandlers } from "../test/fixtures/front-door";
import { MemoryBridge } from "../test/memory-bridge";
import { CommandMenu } from "./command-menu";
import type { RegistryRowView } from "./command-menu-entries";
import { type SidebarSession, SidebarSessionProjectionProvider } from "./sidebar-data";

function project(id: string, name: string): Project {
  return {
    id,
    name,
    path: `/repos/${id}`,
    kind: "repo",
    repoCount: 1,
    branchCount: 1,
    primaryBranch: "main",
    openPath: `/repos/${id}`,
    addedAt: "2026-08-27T00:00:00.000Z",
    source: "local",
  };
}

afterEach(() => {
  cleanup();
  useRennetStore.setState((s) => ({
    ui: { ...s.ui, commandMenuOpen: false, commandMenuMode: "search" },
  }));
});

function mountMenu(
  opts: { mode?: "search" | "command"; registry?: Record<string, RegistryRowView> } = {},
) {
  const history = memoryHistory("/");
  const bridge = new MemoryBridge(
    frontDoorHandlers([project("p1", "atlas"), project("p2", "orbit")]),
  );
  useRennetStore.setState((s) => ({
    ui: { ...s.ui, commandMenuOpen: true, commandMenuMode: opts.mode ?? "search" },
  }));
  const utils = mount(
    <BridgeProvider bridge={bridge}>
      <Router hook={history.hook} searchHook={history.searchHook}>
        <CommandMenu registry={opts.registry} />
      </Router>
    </BridgeProvider>,
  );
  return { ...utils, history };
}

describe("command menu (§9)", () => {
  it("renders grouped entries with the group label beside each title", async () => {
    mountMenu();
    // Projects are real → their entries appear once projects.list resolves.
    await waitFor(() => expect(screen.getByText("atlas — Context Map")).toBeTruthy());
    expect(screen.getByText("New Chat in orbit")).toBeTruthy();
    // Settings pages + actions are always present.
    expect(screen.getByText("Appearance")).toBeTruthy();
    expect(screen.getByText("Add Project")).toBeTruthy();
    // The group label shows beside titles (§9) — "Settings" appears as a row label.
    expect(screen.getAllByText("Settings").length).toBeGreaterThan(0);
  });

  it("fuzzy-filters the list and shows the empty state", async () => {
    mountMenu();
    await waitFor(() => expect(screen.getByText("Appearance")).toBeTruthy());
    const input = screen.getByLabelText("Search commands");
    // Narrow to Appearance.
    act(() => {
      fireEvent.input(input, { target: { value: "Appearance" } });
    });
    await waitFor(() => expect(screen.queryByText("atlas — Context Map")).toBeNull());
    expect(screen.getByText("Appearance")).toBeTruthy();
    // A query nothing matches → the honest empty state.
    act(() => {
      fireEvent.input(input, { target: { value: "zznothingmatches" } });
    });
    await waitFor(() => expect(screen.getByText("No commands match your search.")).toBeTruthy());
  });

  it("runs the selected entry and closes", async () => {
    const { history } = mountMenu();
    await waitFor(() => expect(screen.getByText("Appearance")).toBeTruthy());
    act(() => {
      fireEvent.click(screen.getByText("Appearance"));
    });
    // Closed + navigated to the settings page.
    expect(useRennetStore.getState().ui.commandMenuOpen).toBe(false);
    expect(history.history).toContain("/settings/appearance");
  });

  it("sessions come from the projection; running one opens the chat and routes to it", async () => {
    const history = memoryHistory("/");
    const bridge = new MemoryBridge(frontDoorHandlers([project("p1", "atlas")]));
    useRennetStore.setState((s) => ({ ui: { ...s.ui, commandMenuOpen: true, chatOpen: false } }));
    const sessions: Record<string, readonly SidebarSession[]> = {
      p1: [{ id: "s1", slug: "s1", title: "Alpha review", time: "2h", target: "your-branch" }],
    };
    mount(
      <BridgeProvider bridge={bridge}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          <SidebarSessionProjectionProvider
            value={{
              sessionsByProject: sessions,
              renameSession: () => undefined,
              setSessionPinned: () => undefined,
              archiveSession: () => undefined,
              restoreSession: () => undefined,
              renameProject: () => undefined,
            }}
          >
            <CommandMenu />
          </SidebarSessionProjectionProvider>
        </Router>
      </BridgeProvider>,
    );
    await waitFor(() => expect(screen.getByText("Alpha review")).toBeTruthy());
    act(() => {
      fireEvent.click(screen.getByText("Alpha review"));
    });
    expect(useRennetStore.getState().ui.chatOpen).toBe(true);
    expect(history.history).toContain("/s/s1");
    expect(useRennetStore.getState().ui.commandMenuOpen).toBe(false);
  });

  it("⌘P (search) and ⌘K (command) default to a different view", async () => {
    const search = mountMenu({ mode: "search" });
    await waitFor(() => expect(screen.getByLabelText("Search commands")).toBeTruthy());
    search.unmount();
    cleanup();
    mountMenu({ mode: "command" });
    await waitFor(() => expect(screen.getByLabelText("Run a command")).toBeTruthy());
    // The command-mode input is labelled/placeheld differently from search mode.
    expect(screen.queryByLabelText("Search commands")).toBeNull();
  });
});
