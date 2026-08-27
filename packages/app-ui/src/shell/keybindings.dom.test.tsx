// @vitest-environment happy-dom
//
// The keybinding E2E (packet verification): every advertised bind fires through the ONE
// key owner; ⌘R passes through (R69); a remap persists through `settings.setKeybinding`
// and fires on the NEW chord after a reload; ⌘K executes a registry command end-to-end
// against a fixture registry; Escape priority resolves a dialog + the real menu.
import type { SettingsView } from "@rennet/protocol";
import { type ReactNode, useMemo } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { COMMAND_CATALOGUE, matchKeybinding, normalizeChord } from "../command/commands";
import { KEY_ACTIONS } from "../command/key-actions";
import { SettingsScreen } from "../components/settings-screen";
import { BridgeProvider, useCommand } from "../data";
import { RennetRouterApp } from "../routes/app";
import { memoryHistory } from "../routes/history";
import { useRennetStore } from "../store";
import { act, cleanup, fireEvent, mount, screen, waitFor } from "../test/dom";
import { emptySettings, frontDoorHandlers } from "../test/fixtures/front-door";
import { MemoryBridge, type MemoryBridgeHandlers } from "../test/memory-bridge";
import { CommandMenu } from "./command-menu";
import type { RegistryRowView } from "./command-menu-entries";
import { KeyOwner } from "./key-owner";

/** Renders the loaded keybinding overrides so a test can wait for a reload to settle. */
function SettingsProbe() {
  const { data } = useCommand("settings.get", {});
  return <output data-testid="overrides">{JSON.stringify(data?.keybindings ?? null)}</output>;
}

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
  /** A bridge whose `settings.get` reflects prior `settings.setKeybinding` writes. */
  function mutableSettingsBridge(): MemoryBridge {
    const keybindings: Record<string, string | null> = {};
    return new MemoryBridge({
      ...frontDoorHandlers([]),
      "settings.get": (): SettingsView => ({ ...emptySettings(), keybindings: { ...keybindings } }),
      "settings.setKeybinding": (input) => {
        const { id, keybinding } = input as { id: string; keybinding?: string | null };
        if (keybinding === undefined) delete keybindings[id];
        else keybindings[id] = keybinding;
        return { keybindings: { ...keybindings } };
      },
    });
  }

  function Harness({ bridge, children }: { bridge: MemoryBridge; children: ReactNode }) {
    const history = useMemo(() => memoryHistory("/"), []);
    return (
      <BridgeProvider bridge={bridge}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          {children}
        </Router>
      </BridgeProvider>
    );
  }

  it("remap Toggle Sidebar → ⌘E fires LIVE with the key owner mounted alongside — no reload", async () => {
    const bridge = mutableSettingsBridge();

    // The LIVE topology: the key owner and the shortcuts surface share ONE bridge +
    // cache, exactly as the real frame mounts them (the owner sits above the outlet and
    // never remounts). A remap must reach this live owner WITHOUT a reload — the write
    // invalidates `settings.get`, the owner's shared read refetches, the new bind arms.
    const view = mount(
      <Harness bridge={bridge}>
        <KeyOwner>
          <SettingsProbe />
          <SettingsScreen bridge={bridge} onBack={vi.fn()} />
        </KeyOwner>
      </Harness>,
    );
    fireEvent.click(view.getByRole("tab", { name: "Keyboard" }));
    await waitFor(() => expect(view.container.querySelector(".settings-keys")).not.toBeNull());
    const row = [...view.container.querySelectorAll(".settings-key-row")].find((r) =>
      r.textContent?.includes("Toggle Sidebar"),
    );
    fireEvent.click(row?.querySelector("button") as HTMLButtonElement);
    fireEvent.keyDown(view.getByLabelText("Press the new chord for Toggle Sidebar"), {
      key: "e",
      metaKey: true,
    });

    // The write invalidated `settings.get`; the SAME live owner refetches the override —
    // the probe (which shares that read) shows ⌘E has arrived, with NO remount/reload.
    await waitFor(() => expect(view.getByTestId("overrides").textContent).toContain("mod+e"));

    expect(useRennetStore.getState().ui.sidebarOpen).toBe(true);
    // The OLD chord (⌘B) is dead — remapped away — against the STILL-MOUNTED owner.
    press("b", { meta: true });
    expect(useRennetStore.getState().ui.sidebarOpen).toBe(true);
    // The NEW chord (⌘E) fires the action — live, no reload.
    press("e", { meta: true });
    expect(useRennetStore.getState().ui.sidebarOpen).toBe(false);
  });

  it("the boot path still holds: a fresh key owner loads the persisted override on mount", async () => {
    const bridge = mutableSettingsBridge();

    // Persist the remap through the real shortcuts surface, then throw the surface away.
    const remap = mount(
      <Harness bridge={bridge}>
        <SettingsScreen bridge={bridge} onBack={vi.fn()} />
      </Harness>,
    );
    fireEvent.click(remap.getByRole("tab", { name: "Keyboard" }));
    await waitFor(() => expect(remap.container.querySelector(".settings-keys")).not.toBeNull());
    const row = [...remap.container.querySelectorAll(".settings-key-row")].find((r) =>
      r.textContent?.includes("Toggle Sidebar"),
    );
    fireEvent.click(row?.querySelector("button") as HTMLButtonElement);
    fireEvent.keyDown(remap.getByLabelText("Press the new chord for Toggle Sidebar"), {
      key: "e",
      metaKey: true,
    });
    await waitFor(() => {
      const updated = [...remap.container.querySelectorAll(".settings-key-row")].find((r) =>
        r.textContent?.includes("Toggle Sidebar"),
      );
      expect(updated?.textContent).toContain("⌘e");
    });
    remap.unmount();
    cleanup();
    resetUi();

    // A fresh mount (the reload): the key owner loads the override on boot.
    const reloaded = mount(
      <Harness bridge={bridge}>
        <KeyOwner>
          <SettingsProbe />
        </KeyOwner>
      </Harness>,
    );
    await waitFor(() =>
      expect(reloaded.getByTestId("overrides").textContent).toContain("toggle-sidebar"),
    );

    expect(useRennetStore.getState().ui.sidebarOpen).toBe(true);
    press("b", { meta: true });
    expect(useRennetStore.getState().ui.sidebarOpen).toBe(true);
    press("e", { meta: true });
    expect(useRennetStore.getState().ui.sidebarOpen).toBe(false);
  });

  it("a focused keybinding recorder preempts the window bubble listener — ⌘B does not toggle the sidebar", async () => {
    const bridge = mutableSettingsBridge();

    // The REAL key owner over the REAL shortcuts surface. The window action listener is
    // BUBBLE-phase, so a focused element that consumes the key first (React `onKeyDown` +
    // `stopPropagation` — here the keybinding recorder) must preempt it. Every other
    // keybind test fires on `window` directly, bypassing this exact path.
    const view = mount(
      <Harness bridge={bridge}>
        <KeyOwner>
          <SettingsScreen bridge={bridge} onBack={vi.fn()} />
        </KeyOwner>
      </Harness>,
    );
    fireEvent.click(view.getByRole("tab", { name: "Keyboard" }));
    await waitFor(() => expect(view.container.querySelector(".settings-keys")).not.toBeNull());
    // Enter recording on the Toggle Sidebar row: the recorder input mounts + auto-focuses.
    const row = [...view.container.querySelectorAll(".settings-key-row")].find((r) =>
      r.textContent?.includes("Toggle Sidebar"),
    );
    fireEvent.click(row?.querySelector("button") as HTMLButtonElement);
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
