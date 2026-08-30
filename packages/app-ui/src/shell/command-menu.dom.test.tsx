// @vitest-environment happy-dom
//
// The ⌘P/⌘K command menu (INVENTORY §9) over a MemoryBridge: it opens from the store,
// fuzzy-filters, shows a group label beside each title, states an empty result, runs an
// entry on select (closing + navigating), and defaults to a different view per mode.
import type { Project } from "@rennet/protocol";
import { commands } from "@rennet/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { BridgeProvider } from "../data";
import { memoryHistory } from "../routes/history";
import { useRennetStore } from "../store";
import { act, cleanup, fireEvent, mount, screen, waitFor } from "../test/dom";
import { frontDoorHandlers } from "../test/fixtures/front-door";
import { sessionHandlers } from "../test/fixtures/sessions";
import { MemoryBridge } from "../test/memory-bridge";
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
    it("renders no raw protocol command while keeping command-mode actions available", async () => {
      mountMenu({ mode: "command" });
      await waitFor(() => expect(screen.getByText("Add Project")).toBeTruthy());
      const exposed = Object.entries(commands)
        .filter(([, row]) => row.exposure.commandMenu)
        .map(([id]) => id);
      expect(exposed).toEqual([]);
      // `github.disconnect` is contextual fallback cleanup: under `gh` it cannot act,
      // so Settings owns the only visible button and the static registry row stays out.
      for (const id of [
        "github.disconnect",
        "settings.get",
        "session.list",
        "board.read",
        "review.capture",
      ]) {
        expect(screen.queryByText(id), id).toBeNull();
      }
    });
  });

  it("the Replay row dispatches settings.resetWelcome and closes on success", async () => {
    const reset = vi.fn(() => ({ replayRequestedAt: "2026-08-29T09:30:00.000Z" }));
    const history = memoryHistory("/");
    const bridge = new MemoryBridge({
      ...frontDoorHandlers([project("p1", "atlas")]),
      "settings.resetWelcome": reset,
    });
    useRennetStore.setState((s) => ({
      ui: { ...s.ui, commandMenuOpen: true, commandMenuMode: "command" },
    }));
    mount(
      <BridgeProvider bridge={bridge}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          <CommandMenu />
        </Router>
      </BridgeProvider>,
    );
    await waitFor(() => expect(screen.getByText("Replay the first-run welcome")).toBeTruthy());
    act(() => {
      fireEvent.click(screen.getByText("Replay the first-run welcome"));
    });
    // The real command runs over the bridge — the row is not a label with no wire behind it.
    await waitFor(() => expect(reset).toHaveBeenCalledTimes(1));
    // A registry-command row holds the menu open until the dispatch SETTLES; it closes
    // only on success (a rejection keeps it open carrying the reason).
    await waitFor(() => expect(useRennetStore.getState().ui.commandMenuOpen).toBe(false));
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
