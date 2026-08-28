// @vitest-environment happy-dom
//
// The ⌘P/⌘K command menu (INVENTORY §9) over a MemoryBridge: it opens from the store,
// fuzzy-filters, shows a group label beside each title, states an empty result, runs an
// entry on select (closing + navigating), and defaults to a different view per mode.
import type { GitHubAuthStatus, Project } from "@rennet/protocol";
import { commands } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Router } from "wouter";
import { GitHubAccountRows } from "../components/github-connect";
import { BridgeProvider } from "../data";
import { memoryHistory } from "../routes/history";
import { useRennetStore } from "../store";
import { act, cleanup, fireEvent, mount, screen, waitFor } from "../test/dom";
import { frontDoorHandlers } from "../test/fixtures/front-door";
import { sessionHandlers } from "../test/fixtures/sessions";
import { MemoryBridge, type MemoryBridgeHandlers } from "../test/memory-bridge";
import { CommandMenu } from "./command-menu";

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

function mountMenu(opts: { mode?: "search" | "command" } = {}) {
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
        <CommandMenu />
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
    const bridge = new MemoryBridge({
      ...frontDoorHandlers([project("p1", "atlas")]),
      ...sessionHandlers([{ id: "s1", projectId: "p1", title: "Alpha review" }]),
    });
    useRennetStore.setState((s) => ({ ui: { ...s.ui, commandMenuOpen: true, chatOpen: false } }));
    mount(
      <BridgeProvider bridge={bridge}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          <CommandMenu />
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

  // ── The live registry channel (C11 exposure pass, #477) ────────────────────
  // The menu reads the REAL `commands` table here — no fixture registry — so these
  // prove the shipped `exposure.commandMenu` inventory, not a stand-in.
  describe("registry commands (live exposure inventory)", () => {
    function mountLive(handlers: MemoryBridgeHandlers) {
      const history = memoryHistory("/");
      const bridge = new MemoryBridge({
        ...frontDoorHandlers([project("p1", "atlas")]),
        ...handlers,
      });
      useRennetStore.setState((s) => ({
        ui: { ...s.ui, commandMenuOpen: true, commandMenuMode: "command" },
      }));
      return mount(
        <BridgeProvider bridge={bridge}>
          <Router hook={history.hook} searchHook={history.searchHook}>
            <CommandMenu />
          </Router>
        </BridgeProvider>,
      );
    }

    it("runs an exposed row live through the bridge, once, and closes", async () => {
      // github family — the one exposed row today. One invoke per selection.
      let calls = 0;
      mountLive({
        "github.disconnect": () => {
          calls += 1;
          return {};
        },
      });
      await waitFor(() => expect(screen.getByText("github.disconnect")).toBeTruthy());
      act(() => {
        fireEvent.click(screen.getByText("github.disconnect"));
      });
      await waitFor(() => expect(useRennetStore.getState().ui.commandMenuOpen).toBe(false));
      expect(calls).toBe(1);
    });

    it("renders every menu-exposed row and no unexposed one", async () => {
      mountLive({ "github.disconnect": () => ({}) });
      await waitFor(() => expect(screen.getByText("github.disconnect")).toBeTruthy());
      const exposed = Object.entries(commands)
        .filter(([, row]) => row.exposure.commandMenu)
        .map(([id]) => id);
      for (const id of exposed) expect(screen.getByText(id), id).toBeTruthy();
      // Plumbing reads and argument-bearing commands stay out of the menu entirely.
      for (const id of ["settings.get", "session.list", "board.read", "review.capture"]) {
        expect(screen.queryByText(id), id).toBeNull();
      }
    });

    it("a ⌘K disconnect stales the account read — the card re-reads, never lies connected", async () => {
      // The whole point of exposing an ACTION in the menu: the surfaces that render what
      // it changed must re-read. `useInvoke` invalidates the dispatched row's family, so
      // the GitHub rows drop "connected · @rbutera" without a navigation or a reload.
      let status: GitHubAuthStatus = { state: "connected", login: "rbutera", scopes: ["repo"] };
      const history = memoryHistory("/");
      const bridge = new MemoryBridge({
        ...frontDoorHandlers([project("p1", "atlas")]),
        "github.status": () => ({ status }),
        "github.disconnect": () => {
          status = { state: "not-connected", copy: "GitHub is not connected." };
          return {};
        },
      });
      useRennetStore.setState((s) => ({
        ui: { ...s.ui, commandMenuOpen: true, commandMenuMode: "command" },
      }));
      const { container } = mount(
        <BridgeProvider bridge={bridge}>
          <Router hook={history.hook} searchHook={history.searchHook}>
            <CommandMenu />
            <GitHubAccountRows />
          </Router>
        </BridgeProvider>,
      );

      await waitFor(() =>
        expect(container.querySelector(".github-connected")?.textContent).toContain("@rbutera"),
      );
      act(() => {
        fireEvent.click(screen.getByText("github.disconnect"));
      });
      await waitFor(() => expect(container.querySelector(".github-connected")).toBeNull());
    });

    it("surfaces a failed dispatch instead of closing on it", async () => {
      mountLive({
        "github.disconnect": () => {
          throw new Error("no daemon");
        },
      });
      await waitFor(() => expect(screen.getByText("github.disconnect")).toBeTruthy());
      act(() => {
        fireEvent.click(screen.getByText("github.disconnect"));
      });
      await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("no daemon"));
      expect(useRennetStore.getState().ui.commandMenuOpen).toBe(true);
    });
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
