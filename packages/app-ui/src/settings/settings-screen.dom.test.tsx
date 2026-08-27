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

// ─────────────────────────────────────────────────────────────────────────────
// C10 §12.2 (packet verification) — the cold deep-link sweep. EVERY settings page
// renders its OWN real page from a cold mount (no prior navigation), driven purely
// by the `/settings/:page` route param over the real `RennetRouterApp` — the whole
// point of autopsy S2 (a page is a route, never a shadowed `useState`). Each case
// asserts (a) the settings nav marks that page current and (b) a body marker only
// that page renders — so if the param were ignored and a default page shown, the
// non-target deep-links would surface the WRONG body and fail. That failure mode IS
// the positive control: the sweep passes ONLY because the param drives the page.
// The `/archived` sibling is a main-surface route, not a settings page
// (reconciliation 2), so it renders OUTSIDE the takeover.
// ─────────────────────────────────────────────────────────────────────────────
describe("cold deep-link — the route param drives the page (autopsy S2)", () => {
  const PAGES: readonly {
    readonly slug: string;
    readonly nav: RegExp;
    /** A body marker ONLY this page renders (never the shared nav label). */
    readonly body: (root: HTMLElement) => boolean;
  }[] = [
    {
      slug: "environments",
      nav: /Environments/,
      // The synthesised local card — never present on any other page.
      body: (r) => r.textContent?.includes("This Machine") ?? false,
    },
    {
      slug: "appearance",
      nav: /Appearance/,
      // The Theme Pack section — an appearance-only heading (not in the nav).
      body: (r) => r.textContent?.includes("Theme Pack") ?? false,
    },
    {
      slug: "keybindings",
      nav: /Keyboard Shortcuts/,
      // A KEY_ACTIONS row — only the shortcuts page lists the live binds.
      body: (r) => r.textContent?.includes("Toggle Sidebar") ?? false,
    },
    {
      slug: "projects",
      nav: /Projects/,
      // The projects page tags its own body node regardless of empty/populated.
      body: (r) => r.querySelector('[data-settings-page="projects"]') != null,
    },
  ];

  for (const { slug, nav, body } of PAGES) {
    it(`/settings/${slug} renders its own page cold`, async () => {
      const history = memoryHistory(`/settings/${slug}`);
      const { getByRole } = mount(<RennetRouterApp bridge={frontDoorBridge()} history={history} />);
      await waitFor(() => expect(settingsNode()).toBeTruthy());
      const root = settingsNode() as HTMLElement;

      // The route param made THIS nav item current — the structural proof.
      expect(getByRole("button", { name: nav }).getAttribute("aria-current")).toBe("page");
      // …and the page's own body actually rendered (not a default page's body).
      await waitFor(() => expect(body(settingsNode() as HTMLElement)).toBe(true));
      expect(body(root)).toBe(true);
      cleanup();
    });
  }

  it("/archived renders the sibling surface cold, OUTSIDE the settings takeover", async () => {
    const history = memoryHistory("/archived");
    const { findByText } = mount(<RennetRouterApp bridge={frontDoorBridge()} history={history} />);
    // The honest empty archived surface renders cold; it is NOT a settings page.
    await findByText("Nothing archived.");
    expect(settingsNode()).toBeNull();
    cleanup();
  });
});
