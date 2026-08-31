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
import { KEY_ACTIONS } from "../command/key-actions";
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

describe("ShortcutsPage — the prototype's 32px row rhythm", () => {
  // Asserted as the class FORM, not a measured pixel: happy-dom applies no Tailwind, so
  // `getBoundingClientRect` reports 0 for every row and would pass whatever we shipped.
  // `classList.contains` tokenises, so `h-8` does NOT match a row carrying `min-h-8`.
  function rows(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll('[data-slot="shortcut-row"]'));
  }

  it("gives every ordinary row a fixed h-8 single line", async () => {
    const { container, findByText } = mount(
      <BridgeProvider bridge={shortcutsBridge()}>
        <ShortcutsPage />
      </BridgeProvider>,
    );
    await findByText("Toggle Sidebar");
    const all = rows(container);
    expect(all).toHaveLength(KEY_ACTIONS.length);
    for (const [index, row] of all.entries()) {
      expect(row.classList.contains("h-8")).toBe(true);
      expect(row.classList.contains("min-h-8")).toBe(false);
      // The group survived the move onto the one line. This pins PRESENCE and order,
      // NOT layout — a stacked flex-col yields the same textContent, so what actually
      // forbids the two-line row is the `h-8` above, and this only catches the group
      // being dropped to buy the height back.
      const def = KEY_ACTIONS[index];
      expect(row.textContent?.startsWith(`${def?.title}${def?.group}`)).toBe(true);
    }
    cleanup();
  });

  it("expands only the exceptional rows — a conflict, and the recorder", async () => {
    // ⌘B now binds BOTH Settings and Toggle Sidebar, so those two rows carry the
    // wrapping conflict warning and the other four stay at 32px.
    const { container, findByText, getByLabelText } = mount(
      <BridgeProvider bridge={settingsBridge({ keybindings: { settings: "mod+b" } })}>
        <ShortcutsPage />
      </BridgeProvider>,
    );
    await findByText("Toggle Sidebar");
    const expanded = rows(container).filter((row) => row.classList.contains("min-h-8"));
    expect(expanded.map((row) => row.classList.contains("h-8"))).toEqual([false, false]);
    // Catalogue order, so the sidebar row comes first — a positional assertion, since a
    // pair of `toContain` checks would pass on any two expanded rows.
    expect(expanded[0]?.textContent?.startsWith("Toggle Sidebar")).toBe(true);
    expect(expanded[1]?.textContent?.startsWith("Settings")).toBe(true);

    // The recorder is the other exceptional state: opening it expands its own row.
    const commandMenu = rows(container).find((row) => row.textContent?.startsWith("Command Menu"));
    expect(commandMenu?.classList.contains("h-8")).toBe(true);
    fireEvent.click(getByLabelText("Change Command Menu"));
    await waitFor(() => expect(commandMenu?.classList.contains("min-h-8")).toBe(true));
    expect(commandMenu?.classList.contains("h-8")).toBe(false);
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
