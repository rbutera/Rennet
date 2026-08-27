// @vitest-environment happy-dom
//
// C10 §7 — the Keyboard Shortcuts page over the live settings seam. The page lists the
// SIX advertised app binds (`KEY_ACTIONS`, C11) that the ONE global key owner actually
// fires — NOT the legacy `COMMAND_CATALOGUE` (whose rows the owner never binds). Each
// row shows its effective binding (default overlaid by the override); the filter
// narrows by name; Escape in the filter clears it BEFORE it can close settings (proven
// through the real takeover root); an empty result names the query. Deep-linking the
// page proves it is the C3 Help destination.
//
// The keyboard reconciliation (cluster 11): remapping a row writes through
// `settings.setKeybinding`, which invalidates `settings.get`; the LIVE key owner shares
// that read and rearms with no reload — so what the page advertises stays exactly what
// fires once the old settings-screen is deleted.
import { afterEach, describe, expect, it } from "vitest";
import { BridgeProvider } from "../data";
import { RennetRouterApp } from "../routes/app";
import { memoryHistory } from "../routes/history";
import { useRennetStore } from "../store";
import { act, cleanup, fireEvent, mount, waitFor, within } from "../test/dom";
import { settingsBridge } from "../test/fixtures/settings";
import { MemoryBridge } from "../test/memory-bridge";
import { ShortcutsPage } from "./shortcuts";

function settingsNode(): HTMLElement | null {
  return document.querySelector('[data-screen="settings"]');
}

function shortcutsBridge() {
  // The `settings` bind is remapped to ⌘E; every other bind keeps its default chord.
  return settingsBridge({ keybindings: { settings: "mod+e" } });
}

function resetUi(): void {
  useRennetStore.setState((s) => ({
    ui: { ...s.ui, sidebarOpen: true, chatOpen: false, openDialogs: [] },
  }));
}

afterEach(() => {
  cleanup();
  resetUi();
});

describe("ShortcutsPage — the six advertised binds (KEY_ACTIONS)", () => {
  it("renders the six binds with effective bindings (deep-linked as the C3 destination)", async () => {
    const { getByText, findByText } = mount(
      <RennetRouterApp
        bridge={shortcutsBridge()}
        history={memoryHistory("/settings/keybindings")}
      />,
    );
    await waitFor(() => expect(settingsNode()).toBeTruthy());
    // Every advertised bind appears; the default and the override both render.
    expect(getByText("Toggle Sidebar")).toBeTruthy();
    expect(getByText("Command Menu")).toBeTruthy();
    await findByText("⌘b"); // toggle-sidebar default (mod+b)
    await findByText("⌘e"); // settings override (mod+e)
    cleanup();
  });

  it("does NOT render the legacy COMMAND_CATALOGUE rows (no advertised-but-dead bind)", async () => {
    const { queryByText, findByText } = mount(
      <RennetRouterApp
        bridge={shortcutsBridge()}
        history={memoryHistory("/settings/keybindings")}
      />,
    );
    await findByText("Toggle Sidebar");
    // "Toggle command palette" is a legacy COMMAND_CATALOGUE label the owner never fires.
    expect(queryByText("Toggle command palette")).toBeNull();
    cleanup();
  });

  it("the alias slug resolves to the same page (shortcuts → keybindings)", async () => {
    const { findByText } = mount(
      <RennetRouterApp bridge={shortcutsBridge()} history={memoryHistory("/settings/shortcuts")} />,
    );
    await findByText("Toggle Sidebar");
    cleanup();
  });

  it("the filter narrows by name", async () => {
    const { getByLabelText, findByText, user } = mount(
      <RennetRouterApp
        bridge={shortcutsBridge()}
        history={memoryHistory("/settings/keybindings")}
      />,
    );
    await findByText("Toggle Sidebar");
    await user.type(getByLabelText("Filter commands"), "toggle");
    // Scope to the settings takeover — the app shell renders its own nav labels too.
    const page = within(settingsNode() as HTMLElement);
    expect(page.getByText("Toggle Sidebar")).toBeTruthy();
    expect(page.getByText("Toggle Chat")).toBeTruthy();
    expect(page.queryByText("Search")).toBeNull();
    expect(page.queryByText("New Chat")).toBeNull();
    cleanup();
  });

  it("an empty result names the query", async () => {
    const { getByLabelText, findByText, user } = mount(
      <RennetRouterApp
        bridge={shortcutsBridge()}
        history={memoryHistory("/settings/keybindings")}
      />,
    );
    await findByText("Toggle Sidebar");
    await user.type(getByLabelText("Filter commands"), "zzzznope");
    await findByText("No command matches “zzzznope”.");
    cleanup();
  });

  it("Escape in the filter clears it BEFORE it can close settings", async () => {
    const { getByLabelText, findByText, user } = mount(
      <RennetRouterApp
        bridge={shortcutsBridge()}
        history={memoryHistory("/settings/keybindings")}
      />,
    );
    await findByText("Toggle Sidebar");
    const filter = getByLabelText("Filter commands") as HTMLInputElement;
    await user.type(filter, "zzzznope");
    await findByText("No command matches “zzzznope”.");

    // Escape on the non-empty filter clears it; settings stays open (the registry is back).
    fireEvent.keyDown(filter, { key: "Escape" });
    await findByText("Toggle Sidebar");
    expect(settingsNode()).toBeTruthy();
    expect(filter.value).toBe("");
    cleanup();
  });
});

describe("ShortcutsPage — live remap (the cluster-11 keyboard reconciliation)", () => {
  it("remapping a bind updates the row AND rearms the live key owner with no reload", async () => {
    // The REAL live topology: `RennetRouterApp` mounts the ONE key owner above the outlet
    // and the takeover in it, sharing one bridge + cache. A remap here must reach that
    // live owner without a reload — the write invalidates `settings.get`, the owner's
    // shared read refetches, the new bind arms.
    const view = mount(
      <RennetRouterApp
        bridge={settingsBridge({ keybindings: {} })}
        history={memoryHistory("/settings/keybindings")}
      />,
    );
    await view.findByText("Toggle Sidebar");

    // ⌘B toggles the sidebar today (the default bind is live).
    expect(useRennetStore.getState().ui.sidebarOpen).toBe(true);
    act(() => {
      fireEvent.keyDown(window, { key: "b", metaKey: true });
    });
    expect(useRennetStore.getState().ui.sidebarOpen).toBe(false);
    resetUi();

    // Enter recording on Toggle Sidebar and press ⌘E — the recorder consumes the key
    // (preventDefault + stopPropagation) so the owner does NOT toggle on this keystroke.
    fireEvent.click(view.getByLabelText("Change Toggle Sidebar"));
    const recorder = view.getByLabelText("Press the new chord for Toggle Sidebar");
    act(() => {
      fireEvent.keyDown(recorder, { key: "e", metaKey: true });
    });
    expect(useRennetStore.getState().ui.sidebarOpen).toBe(true);

    // The write invalidated `settings.get`; the row now shows ⌘E — proving the seam wrote
    // and the same read re-rendered.
    await view.findByText("⌘e");

    // The OLD chord (⌘B) is dead; the NEW chord (⌘E) fires the action — live, no reload.
    act(() => {
      fireEvent.keyDown(window, { key: "b", metaKey: true });
    });
    expect(useRennetStore.getState().ui.sidebarOpen).toBe(true);
    act(() => {
      fireEvent.keyDown(window, { key: "e", metaKey: true });
    });
    expect(useRennetStore.getState().ui.sidebarOpen).toBe(false);
    cleanup();
  });
});

describe("ShortcutsPage — backing file + honest read states (P2-8/P2-7)", () => {
  it("names client-settings.json as the backing file, never the legacy config.json (P2-8)", async () => {
    const { container, findByText } = mount(
      <BridgeProvider bridge={settingsBridge({})}>
        <ShortcutsPage />
      </BridgeProvider>,
    );
    await findByText("Toggle Sidebar");
    const backing = container.querySelector('[data-slot="backing-file"]')?.textContent;
    expect(backing).toBe("~/.rennet/client-settings.json");
    expect(container.textContent?.includes("~/.rennet/config.json")).toBe(false);
    cleanup();
  });

  it("discloses a failed live read instead of masking it as no overrides (P2-7)", async () => {
    const bridge = new MemoryBridge({
      "settings.get": () => {
        throw new Error("daemon down");
      },
    });
    const { findByText } = mount(
      <BridgeProvider bridge={bridge}>
        <ShortcutsPage />
      </BridgeProvider>,
    );
    expect(await findByText(/Couldn’t read your saved shortcuts: daemon down/)).toBeTruthy();
    cleanup();
  });
});
