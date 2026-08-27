// @vitest-environment happy-dom
//
// C10 §6.2/§6.4 — the Appearance page's Theme Pack + Code Theme rows over the app-global
// `useThemePref`. Both are live-applying pill rows with NO protocol command (B10-absent
// client prefs): picking a pack stamps `data-rn-theme` on the document root and picking a
// code theme stamps `data-rn-code-theme`, INDEPENDENTLY — the CSS packs wired into
// `@rennet/theme/theme.css` re-bind every --rn-* token off those attributes. The default
// pack (Affineur's Bench) and the default code theme ("Follow theme") CLEAR their
// attribute. The code-surface re-highlight is pure CSS (`.rtok-*` spans read `--rn-syn-*`,
// rebound under `[data-rn-code-theme]`) with no JS; happy-dom has no style engine, so it is
// asserted at the DOM seam the recolour rides — the root attribute governing a mounted
// code surface.
import { describe, expect, it } from "vitest";
import { RennetRouterApp } from "../routes/app";
import { memoryHistory } from "../routes/history";
import { cleanup, mount, waitFor, within } from "../test/dom";
import { settingsBridge } from "../test/fixtures/settings";

function root(): HTMLElement {
  return document.documentElement;
}

/** The pill group for a section, queried by its ToggleGroup aria-label. */
function group(name: string): HTMLElement {
  const el = document.querySelector(`[aria-label="${name}"]`);
  if (!el) throw new Error(`no pill group labelled ${name}`);
  return el as HTMLElement;
}

describe("AppearancePage — Theme Pack + Code Theme (app-global, live)", () => {
  it("a theme-pack pill stamps data-rn-theme live; the default clears it", async () => {
    const { user, findByText } = mount(
      <RennetRouterApp
        bridge={settingsBridge({ scheme: "light" })}
        history={memoryHistory("/settings/appearance")}
      />,
    );
    await findByText("Theme Pack");
    // Default pack ⇒ no attribute (base palette.css).
    expect(root().hasAttribute("data-rn-theme")).toBe(false);

    await user.click(within(group("Theme pack")).getByText("Dracula"));
    await waitFor(() => expect(root().getAttribute("data-rn-theme")).toBe("dracula"));

    // Back to the default pack clears the attribute (never a stale stamp).
    await user.click(within(group("Theme pack")).getByText("Affineur's Bench"));
    await waitFor(() => expect(root().hasAttribute("data-rn-theme")).toBe(false));
    cleanup();
    root().removeAttribute("data-rn-theme");
    root().removeAttribute("data-rn-code-theme");
  });

  it("the code theme applies independently of the pack (neither clears the other)", async () => {
    const { user, findByText } = mount(
      <RennetRouterApp
        bridge={settingsBridge({ scheme: "light" })}
        history={memoryHistory("/settings/appearance")}
      />,
    );
    await findByText("Code Theme");

    // Pick a pack, then a DIFFERENT code theme — both attributes stand at once.
    await user.click(within(group("Theme pack")).getByText("Dracula"));
    await waitFor(() => expect(root().getAttribute("data-rn-theme")).toBe("dracula"));
    await user.click(within(group("Code theme")).getByText("One Dark Pro"));
    await waitFor(() => expect(root().getAttribute("data-rn-code-theme")).toBe("one-dark-pro"));
    // The pack attribute is untouched — the two axes are independent (any pack, any code theme).
    expect(root().getAttribute("data-rn-theme")).toBe("dracula");

    // "Follow theme" (the default) clears ONLY the code-theme attribute; the pack stays.
    await user.click(within(group("Code theme")).getByText("Follow theme"));
    await waitFor(() => expect(root().hasAttribute("data-rn-code-theme")).toBe(false));
    expect(root().getAttribute("data-rn-theme")).toBe("dracula");
    cleanup();
    root().removeAttribute("data-rn-theme");
    root().removeAttribute("data-rn-code-theme");
  });

  it("a code-theme change governs a mounted code surface (the re-highlight scope)", async () => {
    const { user, findByText } = mount(
      <RennetRouterApp
        bridge={settingsBridge({ scheme: "light" })}
        history={memoryHistory("/settings/appearance")}
      />,
    );
    await findByText("Code Theme");

    // A representative code surface: a highlighted token span the CSS recolours by
    // reading `--rn-syn-*`. The recolour is CSS `[data-rn-code-theme] .rtok-*`; here we
    // prove the DOM seam it rides — the surface sits under the root the pick re-stamps.
    const surface = document.createElement("pre");
    surface.innerHTML = '<code><span class="rtok-keyword">const</span></code>';
    document.body.appendChild(surface);
    const token = surface.querySelector(".rtok-keyword") as HTMLElement;

    await user.click(within(group("Code theme")).getByText("GitHub"));
    await waitFor(() => expect(root().getAttribute("data-rn-code-theme")).toBe("github"));
    // The token lives under the root the code-theme attribute now scopes — CSS recolours it.
    expect(root().contains(token)).toBe(true);

    surface.remove();
    cleanup();
    root().removeAttribute("data-rn-theme");
    root().removeAttribute("data-rn-code-theme");
  });
});
