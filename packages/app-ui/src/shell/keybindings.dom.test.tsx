// @vitest-environment happy-dom
//
// The keybinding E2E (packet verification): every advertised bind fires through the ONE
// key owner; ⌘R passes through (R69); a remap persists through `settings.setKeybinding`
// and fires on the NEW chord after a reload; ⌘K executes a registry command end-to-end
// against a fixture registry; Escape priority resolves a dialog + the real menu.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { COMMAND_CATALOGUE, matchKeybinding, normalizeChord } from "../command/commands";
import { KEY_ACTIONS } from "../command/key-actions";
import { BridgeProvider } from "../data";
import { RennetRouterApp } from "../routes/app";
import { memoryHistory } from "../routes/history";
import { useRennetStore } from "../store";
import { act, cleanup, fireEvent, mount, screen, waitFor } from "../test/dom";
import { emptySettings, frontDoorHandlers } from "../test/fixtures/front-door";
import { settingsBridge } from "../test/fixtures/settings";
import { MemoryBridge, type MemoryBridgeHandlers } from "../test/memory-bridge";
import { CommandMenu } from "./command-menu";
import type { RegistryRowView } from "./command-menu-entries";
import { KeyOwner } from "./key-owner";

function resetUi(): void {
  useRennetStore.setState((s) => ({
    ui: {
      ...s.ui,
      sidebarOpen: true,
      chatOpen: false,
      commandMenuOpen: false,
      commandMenuMode: "search",
      openDialogs: [],
    },
  }));
}

afterEach(() => {
  cleanup();
  resetUi();
});

/** Mount the whole router app over a MemoryBridge; returns the recording history. */
function mountApp(handlers: MemoryBridgeHandlers = {}) {
  const history = memoryHistory("/new-chat");
  const bridge = new MemoryBridge({ ...frontDoorHandlers([]), ...handlers });
  const utils = mount(<RennetRouterApp bridge={bridge} history={history} />);
  return { ...utils, history, bridge };
}

function press(key: string, opts: { meta?: boolean } = {}): void {
  act(() => {
    fireEvent.keyDown(window, { key, metaKey: opts.meta ?? false });
  });
}

describe("keybindings — the six advertised binds fire through the one key owner (§14 item 1)", () => {
  it("⌘P opens the menu search-first; ⌘K command-first", () => {
    mountApp();
    press("p", { meta: true });
    expect(useRennetStore.getState().ui.commandMenuOpen).toBe(true);
    expect(useRennetStore.getState().ui.commandMenuMode).toBe("search");
    resetUi();
    press("k", { meta: true });
    expect(useRennetStore.getState().ui.commandMenuOpen).toBe(true);
    expect(useRennetStore.getState().ui.commandMenuMode).toBe("command");
  });

  it("⌘N opens the new-chat dialog; ⌘B toggles the sidebar; ⌘J toggles the chat", () => {
    mountApp();
    press("n", { meta: true });
    expect(useRennetStore.getState().ui.openDialogs).toContain("new-chat");

    expect(useRennetStore.getState().ui.sidebarOpen).toBe(true);
    press("b", { meta: true });
    expect(useRennetStore.getState().ui.sidebarOpen).toBe(false);

    expect(useRennetStore.getState().ui.chatOpen).toBe(false);
    press("j", { meta: true });
    expect(useRennetStore.getState().ui.chatOpen).toBe(true);
  });

  it("⌘, routes to settings", () => {
    const { history } = mountApp();
    press(",", { meta: true });
    expect(history.history).toContain("/settings/appearance");
  });

  it("⌘R is never intercepted and no shortcuts row references reload (R69, registry half)", () => {
    const { history } = mountApp();
    const before = history.history.length;
    press("r", { meta: true });
    // The app never binds ⌘R: the menu stays shut, nothing navigates.
    expect(useRennetStore.getState().ui.commandMenuOpen).toBe(false);
    expect(history.history.length).toBe(before);
    // ⌘R matches no catalogued action, and no row advertises reload.
    const rChord = normalizeChord("mod+r");
    expect(rChord && matchKeybinding(KEY_ACTIONS, rChord)).toBeUndefined();
    expect(
      KEY_ACTIONS.some(
        (def) =>
          (typeof def.title === "string" && /reload|refresh/i.test(def.title)) ||
          def.keybinding === "mod+r",
      ),
    ).toBe(false);
  });
});

describe("keybind remapping (R70/#492) — remap persists and fires on the new chord after reload", () => {
  // The shortcuts surface is now C10's Keyboard-Shortcuts page (the old tabbed
  // `settings-screen` is deleted). `RennetRouterApp` mounts the ONE key owner above the
  // outlet and the settings takeover in it, sharing one bridge + cache — the real live
  // topology. `settingsBridge` is a stateful store, so a `settings.setKeybinding` write
  // persists and `settings.get` re-reads it.

  /** Deep-link the app at the Keyboard-Shortcuts page over a stateful settings bridge. */
  function mountShortcuts(bridge: MemoryBridge) {
    return mount(
      <RennetRouterApp bridge={bridge} history={memoryHistory("/settings/keybindings")} />,
    );
  }

  /** Enter recording on the Toggle Sidebar row and record the given chord key. */
  async function remapToggleSidebar(view: ReturnType<typeof mount>, key: string): Promise<void> {
    await view.findByText("Toggle Sidebar");
    fireEvent.click(view.getByLabelText("Change Toggle Sidebar"));
    act(() => {
      fireEvent.keyDown(view.getByLabelText("Press the new chord for Toggle Sidebar"), {
        key,
        metaKey: true,
      });
    });
  }

  it("remap Toggle Sidebar → ⌘E fires LIVE with the key owner mounted alongside — no reload", async () => {
    const bridge = settingsBridge({ keybindings: {} });

    // The LIVE topology: the key owner and the shortcuts surface share ONE bridge +
    // cache, exactly as the real frame mounts them (the owner sits above the outlet and
    // never remounts). A remap must reach this live owner WITHOUT a reload — the write
    // invalidates `settings.get`, the owner's shared read refetches, the new bind arms.
    const view = mountShortcuts(bridge);
    await remapToggleSidebar(view, "e");

    // The write invalidated `settings.get`; the SAME live owner refetches the override —
    // the row now shows ⌘E has arrived, with NO remount/reload.
    await view.findByText("⌘e");

    expect(useRennetStore.getState().ui.sidebarOpen).toBe(true);
    // The OLD chord (⌘B) is dead — remapped away — against the STILL-MOUNTED owner.
    press("b", { meta: true });
    expect(useRennetStore.getState().ui.sidebarOpen).toBe(true);
    // The NEW chord (⌘E) fires the action — live, no reload.
    press("e", { meta: true });
    expect(useRennetStore.getState().ui.sidebarOpen).toBe(false);
  });

  it("the boot path still holds: a fresh key owner loads the persisted override on mount", async () => {
    const bridge = settingsBridge({ keybindings: {} });

    // Persist the remap through the real shortcuts surface, then throw the surface away.
    const remap = mountShortcuts(bridge);
    await remapToggleSidebar(remap, "e");
    await remap.findByText("⌘e");
    remap.unmount();
    cleanup();
    resetUi();

    // A fresh mount (the reload) over the SAME stateful bridge: the key owner loads the
    // persisted override on boot. The row rendering ⌘E confirms the fresh `settings.get`
    // read has settled before we press.
    const reloaded = mountShortcuts(bridge);
    await reloaded.findByText("⌘e");

    press("b", { meta: true });
    expect(useRennetStore.getState().ui.sidebarOpen).toBe(true);
    press("e", { meta: true });
    expect(useRennetStore.getState().ui.sidebarOpen).toBe(false);
  });

  it("a focused keybinding recorder preempts the window bubble listener — ⌘B does not toggle the sidebar", async () => {
    const bridge = settingsBridge({ keybindings: {} });

    // The REAL key owner over the REAL shortcuts surface. The window action listener is
    // BUBBLE-phase, so a focused element that consumes the key first (React `onKeyDown` +
    // `stopPropagation` — here the keybinding recorder) must preempt it. Every other
    // keybind test fires on `window` directly, bypassing this exact path.
    const view = mountShortcuts(bridge);
    await view.findByText("Toggle Sidebar");
    // Enter recording on the Toggle Sidebar row: the recorder input mounts + auto-focuses.
    fireEvent.click(view.getByLabelText("Change Toggle Sidebar"));
    const recorder = view.getByLabelText("Press the new chord for Toggle Sidebar");

    expect(useRennetStore.getState().ui.sidebarOpen).toBe(true);
    // ⌘B dispatched ON THE FOCUSED RECORDER bubbles through React's `onKeyDown`, which
    // `preventDefault`+`stopPropagation`s it — the window bubble listener must NEVER see
    // it, so the global sidebar toggle does not fire.
    act(() => {
      fireEvent.keyDown(recorder, { key: "b", metaKey: true });
    });
    expect(useRennetStore.getState().ui.sidebarOpen).toBe(true);

    // Positive control: the SAME ⌘B dispatched on `window` (bypassing the recorder)
    // DOES toggle — proving the bind is live and the only thing that stopped it above was
    // the focused consumer's preemption, not an inert chord.
    act(() => {
      fireEvent.keyDown(window, { key: "b", metaKey: true });
    });
    expect(useRennetStore.getState().ui.sidebarOpen).toBe(false);
  });
});

describe("registry-command execution (cluster 6) — ⌘K runs a commandMenu:true row end-to-end", () => {
  it("opens command mode, surfaces the fixture row, and dispatches it on select", async () => {
    const ran = vi.fn(() => ({ detected: [] }));
    // A fixture registry with ONE commandMenu:true row (B10 is unlanded — reconciliation 6).
    const registry: Record<string, RegistryRowView> = {
      "harness.detect": { label: "harness.detect", exposure: { commandMenu: true } },
    };
    const bridge = new MemoryBridge({
      ...frontDoorHandlers([]),
      "settings.get": () => emptySettings(),
      "harness.detect": ran as unknown as MemoryBridgeHandlers["harness.detect"],
    });
    const history = memoryHistory("/");
    mount(
      <BridgeProvider bridge={bridge}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          <KeyOwner>
            <CommandMenu registry={registry} />
          </KeyOwner>
        </Router>
      </BridgeProvider>,
    );

    // ⌘K opens the menu (command mode) — the registry row is now visible.
    press("k", { meta: true });
    expect(useRennetStore.getState().ui.commandMenuMode).toBe("command");
    await waitFor(() => expect(screen.getByText("harness.detect")).toBeTruthy());

    // Selecting it dispatches the command through the bridge and closes the menu.
    act(() => {
      fireEvent.click(screen.getByText("harness.detect"));
    });
    await waitFor(() => expect(ran).toHaveBeenCalledTimes(1));
    expect(useRennetStore.getState().ui.commandMenuOpen).toBe(false);
  });
});

describe("Escape priority — a dialog + the real menu, resolved by the stack (autopsy S7)", () => {
  it("Escape closes the dialog first, a second Escape closes the menu", async () => {
    const bridge = new MemoryBridge({
      ...frontDoorHandlers([]),
      "settings.get": () => emptySettings(),
    });
    const history = memoryHistory("/");
    mount(
      <BridgeProvider bridge={bridge}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          <KeyOwner>
            <CommandMenu />
          </KeyOwner>
        </Router>
      </BridgeProvider>,
    );
    act(() => {
      useRennetStore.getState().uiActions.setCommandMenuOpen(true);
      useRennetStore.getState().uiActions.openDialog("confirm");
    });
    // Both open: a store dialog on top of the real (Base UI) command menu.
    expect(useRennetStore.getState().ui.openDialogs).toEqual(["confirm"]);
    expect(useRennetStore.getState().ui.commandMenuOpen).toBe(true);

    press("Escape");
    expect(useRennetStore.getState().ui.openDialogs).toEqual([]);
    expect(useRennetStore.getState().ui.commandMenuOpen).toBe(true);

    press("Escape");
    expect(useRennetStore.getState().ui.commandMenuOpen).toBe(false);
  });
});

describe("the legacy command catalogue is no longer the shortcuts surface", () => {
  it("the six-bind catalogue drives the shortcuts page, not the deleted palette's dead rows", () => {
    // COMMAND_CATALOGUE still exists for the helpers' tests, but the six live binds are
    // the ONLY advertised keyboard rows now (no palette.toggle / nav.* dead rows).
    const legacyIds = new Set(COMMAND_CATALOGUE.map((d) => d.id));
    const liveIds = new Set(KEY_ACTIONS.map((d) => d.id));
    expect([...liveIds]).toEqual([
      "search",
      "commands",
      "new-chat",
      "toggle-sidebar",
      "toggle-chat",
      "settings",
    ]);
    // No overlap: the live binds are their own catalogue.
    expect([...liveIds].some((id) => legacyIds.has(id))).toBe(false);
  });
});
