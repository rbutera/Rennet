// @vitest-environment happy-dom
//
// C10 §7 — the Keyboard Shortcuts page over the live settings seam. The registry
// renders every catalogued command with its effective binding (default overlaid by
// the override); the filter narrows by name; Escape in the filter clears it BEFORE it
// can close settings (proven through the real takeover root); an empty result names
// the query. Deep-linking the page proves it is the C3 Help destination.
import { describe, expect, it } from "vitest";
import { RennetRouterApp } from "../routes/app";
import { memoryHistory } from "../routes/history";
import { cleanup, fireEvent, mount, waitFor } from "../test/dom";
import { settingsBridge } from "../test/fixtures/settings";

function settingsNode(): HTMLElement | null {
  return document.querySelector('[data-screen="settings"]');
}

function shortcutsBridge() {
  // nav.settings is remapped; palette.toggle keeps its ⌘k default.
  return settingsBridge({ keybindings: { "nav.settings": "mod+e" } });
}

describe("ShortcutsPage — the keyboard registry", () => {
  it("renders the registry with effective bindings (deep-linked as the C3 destination)", async () => {
    const { getByText, findByText } = mount(
      <RennetRouterApp
        bridge={shortcutsBridge()}
        history={memoryHistory("/settings/keybindings")}
      />,
    );
    await waitFor(() => expect(settingsNode()).toBeTruthy());
    // Every catalogued command appears; the palette default and the override both render.
    expect(getByText("Toggle command palette")).toBeTruthy();
    await findByText("⌘k"); // palette.toggle default
    await findByText("⌘e"); // nav.settings override (mod+e)
    cleanup();
  });

  it("the alias slug resolves to the same page (shortcuts → keybindings)", async () => {
    const { findByText } = mount(
      <RennetRouterApp bridge={shortcutsBridge()} history={memoryHistory("/settings/shortcuts")} />,
    );
    await findByText("Toggle command palette");
    cleanup();
  });

  it("the filter narrows by name", async () => {
    const { getByLabelText, getByText, queryByText, findByText, user } = mount(
      <RennetRouterApp
        bridge={shortcutsBridge()}
        history={memoryHistory("/settings/keybindings")}
      />,
    );
    await findByText("Toggle command palette");
    await user.type(getByLabelText("Filter commands"), "settings");
    expect(getByText("Open Settings")).toBeTruthy();
    expect(queryByText("Toggle command palette")).toBeNull();
    cleanup();
  });

  it("an empty result names the query", async () => {
    const { getByLabelText, findByText, user } = mount(
      <RennetRouterApp
        bridge={shortcutsBridge()}
        history={memoryHistory("/settings/keybindings")}
      />,
    );
    await findByText("Toggle command palette");
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
    await findByText("Toggle command palette");
    const filter = getByLabelText("Filter commands") as HTMLInputElement;
    await user.type(filter, "zzzznope");
    await findByText("No command matches “zzzznope”.");

    // Escape on the non-empty filter clears it; settings stays open (the registry is back).
    fireEvent.keyDown(filter, { key: "Escape" });
    await findByText("Toggle command palette");
    expect(settingsNode()).toBeTruthy();
    expect(filter.value).toBe("");
    cleanup();
  });
});
