// @vitest-environment happy-dom
//
// C10 §1.4 — the Settings takeover shell over a MemoryBridge + memory history. The
// shell mounts from the `/settings/:page` route, the `esc` hint shows, the four pages
// list in the nav, Escape (and the back arrow) leave to the PRIOR surface, and the
// always-mounted chat-dock slot survives the visit un-remounted (the "chat + board
// stay mounted" claim, proven by DOM-node identity across the round-trip).
import type { Project } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { RennetRouterApp } from "../routes/app";
import { memoryHistory } from "../routes/history";
import { act, cleanup, fireEvent, mount, waitFor } from "../test/dom";
import { frontDoorBridge, frontDoorHandlers } from "../test/fixtures/front-door";
import { MemoryBridge } from "../test/memory-bridge";

function mkProj(id: string, name: string, openPath: string): Project {
  return {
    id,
    name,
    source: "local",
    path: `/repos/${id}`,
    kind: "repo",
    repoCount: 1,
    branchCount: 1,
    primaryBranch: "main",
    openPath,
    addedAt: "2026-08-01T00:00:00.000Z",
  };
}

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
    await findByText("Add a project to begin.");
    const dockBefore = getByTestId("chat-dock-slot");

    act(() => history.navigate("/settings/appearance"));
    await waitFor(() => expect(settingsNode()).toBeTruthy());

    // Escape on the focused takeover root leaves to where we came from.
    act(() => {
      const root = settingsNode();
      if (root) fireEvent.keyDown(root, { key: "Escape" });
    });
    await findByText("Add a project to begin.");
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
    await findByText("Add a project to begin.");
    act(() => history.navigate("/settings/appearance"));
    await waitFor(() => expect(settingsNode()).toBeTruthy());

    fireEvent.click(getByRole("button", { name: "Back" }));
    await findByText("Add a project to begin.");
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

// ─────────────────────────────────────────────────────────────────────────────
// C10 §10.2 + §8 nav — cross-route persistence the route-local takeover must NOT drop.
// P1-4: the left nav carries `?project` across sibling settings routes, so a hop out
// and back keeps the reader's chosen project instead of snapping to the first.
// P1-2: per-session agent enablement lives ABOVE the route switch (app.tsx), so leaving
// and reopening Settings preserves it; only a full app remount (a reload) resets it.
// ─────────────────────────────────────────────────────────────────────────────
const NAV_PROJECTS: readonly Project[] = [
  mkProj("p1", "checkout", "/checkout"),
  mkProj("p2", "billing", "/billing"),
];

function projectName(getByLabelText: (t: string) => HTMLElement): string {
  return (getByLabelText("Project name") as HTMLInputElement).value;
}

describe("Settings nav preserves ?project across sibling routes (P1-4)", () => {
  it("Projects → Appearance → Projects keeps the scoped project", async () => {
    const history = memoryHistory("/settings/projects?project=p2");
    const { findByLabelText, getByLabelText, getByRole } = mount(
      <RennetRouterApp bridge={frontDoorBridge(NAV_PROJECTS)} history={history} />,
    );
    // Cold deep-link scopes to p2.
    expect(((await findByLabelText("Project name")) as HTMLInputElement).value).toBe("billing");
    // Hop to Appearance via the nav, then back to Projects via the nav.
    fireEvent.click(getByRole("button", { name: /Appearance/ }));
    await waitFor(() =>
      expect(getByRole("button", { name: /Appearance/ }).getAttribute("aria-current")).toBe("page"),
    );
    fireEvent.click(getByRole("button", { name: /Projects/ }));
    // Still p2 — the query survived the round trip (it used to fall back to the first project).
    await findByLabelText("Project name");
    expect(projectName(getByLabelText)).toBe("billing");
    cleanup();
  });
});

describe("Agent enablement persists across leaving Settings (P1-2)", () => {
  /**
   * A bridge over a SERVED enable store (C17 cluster 3.2): `harness.setEnabled` writes the
   * host's ruled-out ids into `stored`, and `harness.hosts` reads them back. `stored` lives
   * outside the bridge, so a full app remount — a reload — meets the SAME store, which is
   * the whole point of the store: the decision outlives the renderer.
   */
  const stored = new Map<string, ReadonlySet<string>>();
  function agentBridge(): MemoryBridge {
    return new MemoryBridge(
      {
        ...frontDoorHandlers(NAV_PROJECTS),
        "harness.hosts": () => ({
          hosts: [
            {
              source: "local" as const,
              asked: true,
              detected: [
                {
                  id: "claude",
                  version: "2.1.0",
                  enabled: !stored.get("local")?.has("claude"),
                },
              ],
            },
          ],
        }),
        "harness.setEnabled": (input) => {
          const disabled = new Set(stored.get(input.source) ?? []);
          if (input.enabled) disabled.delete(input.harnessId);
          else disabled.add(input.harnessId);
          stored.set(input.source, disabled);
          return { disabled: [...disabled] };
        },
      },
      { platform: "darwin", version: "1.0.1" },
    );
  }

  async function claudeToggle(findByRole: (role: string, opts: object) => Promise<HTMLElement>) {
    return findByRole("switch", { name: "Use Claude on This Machine" });
  }

  it("disable → leave → reopen keeps it disabled, and so does a full remount", async () => {
    const history = memoryHistory("/settings/environments");
    const first = mount(<RennetRouterApp bridge={agentBridge()} history={history} />);
    const toggle = await claudeToggle(first.findByRole);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await first.user.click(toggle);
    await waitFor(async () =>
      expect((await claudeToggle(first.findByRole)).getAttribute("aria-checked")).toBe("false"),
    );
    // Leave Settings entirely (the takeover unmounts), then reopen it.
    act(() => history.navigate("/new-chat"));
    await first.findByText("No open branches or change requests yet.");
    act(() => history.navigate("/settings/environments"));
    // The provider lives above the route switch, so the disabled choice survived.
    expect((await claudeToggle(first.findByRole)).getAttribute("aria-checked")).toBe("false");
    cleanup();

    // A full app remount (a reload) is where a SESSION-only set used to lose the decision.
    // With the served store it survives: a fresh app, a fresh bridge, the same answer.
    const second = mount(
      <RennetRouterApp bridge={agentBridge()} history={memoryHistory("/settings/environments")} />,
    );
    expect((await claudeToggle(second.findByRole)).getAttribute("aria-checked")).toBe("false");
    cleanup();
  });
});
