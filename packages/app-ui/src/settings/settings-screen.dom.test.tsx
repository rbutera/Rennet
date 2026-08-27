// @vitest-environment happy-dom
//
// C10 §1.4 — the Settings takeover shell over a MemoryBridge + memory history. The
// shell mounts from the `/settings/:page` route, the `esc` hint shows, the four pages
// list in the nav, Escape (and the back arrow) leave to the PRIOR surface, and the
// always-mounted chat-dock slot survives the visit un-remounted (the "chat + board
// stay mounted" claim, proven by DOM-node identity across the round-trip).
import { describe, expect, it } from "vitest";
import { RennetRouterApp } from "../routes/app";
import { memoryHistory } from "../routes/history";
import { act, cleanup, fireEvent, mount, waitFor } from "../test/dom";
import { frontDoorBridge } from "../test/fixtures/front-door";

function settingsNode(): HTMLElement | null {
  return document.querySelector('[data-screen="settings"]');
}

describe("SettingsScreen — the takeover shell", () => {
  it("mounts from the route param, lists the four pages, and shows the esc hint", async () => {
    const history = memoryHistory("/settings/appearance");
    const { getByRole, getByText } = mount(
      <RennetRouterApp bridge={frontDoorBridge()} history={history} />,
    );
    await waitFor(() => expect(settingsNode()).toBeTruthy());

    // The `esc` hint and the back control.
    expect(getByText("esc")).toBeTruthy();
    expect(getByRole("button", { name: "Back" })).toBeTruthy();

    // The four pages, in order, with Appearance active (the route param drives it).
    for (const label of ["Environments", "Appearance", "Keyboard Shortcuts", "Projects"]) {
      expect(getByRole("button", { name: new RegExp(label) })).toBeTruthy();
    }
    expect(getByRole("button", { name: /Appearance/ }).getAttribute("aria-current")).toBe("page");
    cleanup();
  });

  it("the route PARAM selects the page, not a shadowed useState (deep-link cold)", async () => {
    const history = memoryHistory("/settings/keybindings");
    const { getByRole } = mount(<RennetRouterApp bridge={frontDoorBridge()} history={history} />);
    await waitFor(() => expect(settingsNode()).toBeTruthy());
    // A cold deep-link to keybindings makes THAT nav item current — proof the param,
    // not a default state, drives the page.
    expect(getByRole("button", { name: /Keyboard Shortcuts/ }).getAttribute("aria-current")).toBe(
      "page",
    );
    cleanup();
  });

  it("Escape leaves to the prior surface (the front door), chat-dock kept mounted", async () => {
    const history = memoryHistory("/new-chat");
    const { findByText, getByTestId } = mount(
      <RennetRouterApp bridge={frontDoorBridge()} history={history} />,
    );
    await findByText("Start a review.");
    const dockBefore = getByTestId("chat-dock-slot");

    act(() => history.navigate("/settings/appearance"));
    await waitFor(() => expect(settingsNode()).toBeTruthy());

    // Escape on the focused takeover root leaves to where we came from.
    act(() => {
      const root = settingsNode();
      if (root) fireEvent.keyDown(root, { key: "Escape" });
    });
    await findByText("Start a review.");
    expect(settingsNode()).toBeNull();

    // The SAME dock node — the visit swapped only the outlet, never the dock slot.
    expect(getByTestId("chat-dock-slot")).toBe(dockBefore);
    cleanup();
  });

  it("the back arrow leaves to the prior surface", async () => {
    const history = memoryHistory("/new-chat");
    const { findByText, getByRole } = mount(
      <RennetRouterApp bridge={frontDoorBridge()} history={history} />,
    );
    await findByText("Start a review.");
    act(() => history.navigate("/settings/appearance"));
    await waitFor(() => expect(settingsNode()).toBeTruthy());

    fireEvent.click(getByRole("button", { name: "Back" }));
    await findByText("Start a review.");
    expect(settingsNode()).toBeNull();
    cleanup();
  });
});
