// @vitest-environment happy-dom
//
// App-wide appearance (wireframe #15), ported from the deleted legacy-shell suite
// (`app.scheme.dom.test.tsx`) to the #480 router. The resolved scheme is applied to
// the document ROOT, so EVERY surface inherits it — not only screens that thread a
// `scheme` prop. Asserts `document.documentElement`'s `data-scheme` on the front
// door, across a route round-trip, and that a live OS `prefers-color-scheme` change
// re-themes without a reload. Positive control (shown once during verification):
// dropping the `AppearanceSync` mount in app.tsx reddens the first assertion.
import type { SettingsView } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, mount, waitFor } from "../test/dom";
import { emptySettings, frontDoorHandlers } from "../test/fixtures/front-door";
import { MemoryBridge } from "../test/memory-bridge";
import { RennetRouterApp } from "./app";
import { memoryHistory } from "./history";

/** Install a controllable `prefers-color-scheme` mock; returns a `fire` to flip it. */
function installMatchMedia(initialDark: boolean): { fire(dark: boolean): void } {
  const listeners = new Set<(event: { matches: boolean }) => void>();
  let matches = initialDark;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      get matches() {
        return matches;
      },
      media: query,
      addEventListener: (_: string, cb: (event: { matches: boolean }) => void) => listeners.add(cb),
      removeEventListener: (_: string, cb: (event: { matches: boolean }) => void) =>
        listeners.delete(cb),
    }),
  });
  return {
    fire(dark: boolean) {
      matches = dark;
      for (const cb of [...listeners]) cb({ matches: dark });
    },
  };
}

/** A MemoryBridge that boots to the front door but answers `settings.get` with `scheme`. */
function schemeBridge(scheme: SettingsView["scheme"]): MemoryBridge {
  return new MemoryBridge({
    ...frontDoorHandlers(),
    "settings.get": () => ({ ...emptySettings(), scheme }),
  });
}

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-scheme");
});

describe("RennetRouterApp — app-wide appearance via the document root", () => {
  it("themes the document root from an explicit Light, on the front door", async () => {
    installMatchMedia(true); // OS is dark, but the explicit choice must win
    mount(<RennetRouterApp bridge={schemeBridge("light")} history={memoryHistory("/new-chat")} />);
    await waitFor(() => expect(document.documentElement.getAttribute("data-scheme")).toBe("light"));
  });

  it("keeps the root themed across a takeover route round-trip", async () => {
    installMatchMedia(true);
    const history = memoryHistory("/new-chat");
    const { findByText } = mount(
      <RennetRouterApp bridge={schemeBridge("light")} history={history} />,
    );
    await findByText("Start a review.");
    await waitFor(() => expect(document.documentElement.getAttribute("data-scheme")).toBe("light"));
    act(() => history.navigate("/settings/appearance"));
    await waitFor(() => expect(document.querySelector('[data-screen="settings"]')).toBeTruthy());
    // The root is STILL light — the screen inherits it rather than falling to dark.
    expect(document.documentElement.getAttribute("data-scheme")).toBe("light");
  });

  it("follows a live OS prefers-color-scheme change when the scheme is `system`", async () => {
    const media = installMatchMedia(true); // system → dark initially
    mount(<RennetRouterApp bridge={schemeBridge("system")} history={memoryHistory("/new-chat")} />);
    await waitFor(() => expect(document.documentElement.getAttribute("data-scheme")).toBe("dark"));
    // The OS flips to light; the app re-themes with no reload.
    act(() => media.fire(false));
    await waitFor(() => expect(document.documentElement.getAttribute("data-scheme")).toBe("light"));
  });
});
