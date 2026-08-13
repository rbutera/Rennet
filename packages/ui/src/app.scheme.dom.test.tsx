// @vitest-environment happy-dom
//
// App-wide appearance (wireframe #15): the resolved scheme is applied to the
// document ROOT, so EVERY surface inherits it — not only the screens that thread a
// `scheme` prop. This mounts the whole `RennetApp` and asserts `document.
// documentElement`'s `data-scheme` across the front-door and direct-entry routes,
// and that a live OS `prefers-color-scheme` change re-themes without a reload.
import type { RennetBridge } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { RennetApp } from "./app";
import { cleanup, fireEvent, mount, waitFor } from "./test/dom";

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

function fakeBridge(scheme: "dark" | "light" | "system"): RennetBridge {
  const invoke = async (name: string): Promise<unknown> => {
    switch (name) {
      case "app.bootstrap":
        return { review: null };
      case "settings.get":
        return {
          scheme,
          schemeProvenance: { layer: "builtin", contributions: [] },
          appearanceMalformed: false,
          projects: [],
        };
      case "projects.list":
        return { projects: [] };
      case "harness.detect":
        return { detected: [] };
      default:
        return {};
    }
  };
  return { invoke: invoke as unknown as RennetBridge["invoke"] };
}

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-scheme");
});

describe("RennetApp — app-wide appearance via the document root", () => {
  it("themes the document root from an explicit Light, on the front door", async () => {
    installMatchMedia(true); // OS is dark, but the explicit choice must win
    mount(<RennetApp bridge={fakeBridge("light")} />);
    await waitFor(() => expect(document.documentElement.getAttribute("data-scheme")).toBe("light"));
  });

  it("keeps the root themed on the palette-only direct-entry route", async () => {
    installMatchMedia(true);
    const { container, getByRole, queryByRole } = mount(<RennetApp bridge={fakeBridge("light")} />);
    await waitFor(() => expect(container.querySelector(".front-door")).not.toBeNull());
    // The legacy door is no longer drawn; its existing palette command is the seam
    // until Phase 4 replaces the command registry's navigation group.
    expect(queryByRole("button", { name: /Review directly/ })).toBeNull();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await waitFor(() => getByRole("button", { name: /Review directly/ }));
    fireEvent.click(getByRole("button", { name: /Review directly/ }));
    await waitFor(() => getByRole("heading", { name: /Start a review/ }));
    // The root is STILL light — the screen inherits it rather than falling to dark.
    expect(document.documentElement.getAttribute("data-scheme")).toBe("light");
  });

  it("follows a live OS prefers-color-scheme change when the scheme is `system`", async () => {
    const media = installMatchMedia(true); // system → dark initially
    mount(<RennetApp bridge={fakeBridge("system")} />);
    await waitFor(() => expect(document.documentElement.getAttribute("data-scheme")).toBe("dark"));
    // The OS flips to light; the app re-themes with no reload.
    media.fire(false);
    await waitFor(() => expect(document.documentElement.getAttribute("data-scheme")).toBe("light"));
  });
});
