// @vitest-environment happy-dom
//
// Host-app update readiness (spec: desktop-update-notification): a host bridge
// push badges the chrome Rennet mark, clicking it opens the restart prompt, and
// applying routes to the host's `applyUpdate`. A bridge WITHOUT the update
// members (browser shell, tests) leaves the chrome untouched — the feature is
// structurally inert there.
import type { RennetBridge, UpdateReadyInfo } from "@rennet/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RennetApp } from "./app";
import { useUpdateReady } from "./components/update-ready";
import { cleanup, fireEvent, mount, waitFor } from "./test/dom";

function installMatchMedia(): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
}

interface UpdateHost {
  push(info: UpdateReadyInfo): void;
  applied: number;
  bridge: RennetBridge;
}

function fakeBridge(withUpdater: boolean): UpdateHost {
  const listeners = new Set<(info: UpdateReadyInfo) => void>();
  const invoke = async (name: string): Promise<unknown> => {
    switch (name) {
      case "app.bootstrap":
        return { review: null, repositoryPresent: false };
      case "settings.get":
        return {
          scheme: "light",
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
  const host: UpdateHost = {
    push: (info) => {
      for (const listener of [...listeners]) listener(info);
    },
    applied: 0,
    bridge: { invoke: invoke as unknown as RennetBridge["invoke"] },
  };
  if (withUpdater) {
    host.bridge.onUpdateReady = (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    host.bridge.applyUpdate = () => {
      host.applied += 1;
    };
  }
  return host;
}

beforeEach(() => {
  installMatchMedia();
});

afterEach(() => {
  cleanup();
  useUpdateReady.setState({ ready: null, promptOpen: false });
  document.documentElement.removeAttribute("data-scheme");
});

describe("RennetApp — update readiness badge on the chrome mark", () => {
  it("renders a plain decorative mark when the host has no updater", async () => {
    const host = fakeBridge(false);
    const { container, queryByRole } = mount(<RennetApp bridge={host.bridge} />);
    await waitFor(() => expect(container.querySelector(".front-door")).not.toBeNull());
    expect(queryByRole("button", { name: /Update ready/ })).toBeNull();
    expect(container.querySelector(".chrome-mark-badge")).toBeNull();
    const mark = container.querySelector(".front-door-mark");
    expect(mark?.tagName).toBe("SPAN");
  });

  it("stays badge-free before any push even with an updater present", async () => {
    const host = fakeBridge(true);
    const { container, queryByRole } = mount(<RennetApp bridge={host.bridge} />);
    await waitFor(() => expect(container.querySelector(".front-door")).not.toBeNull());
    expect(queryByRole("button", { name: /Update ready/ })).toBeNull();
    expect(container.querySelector(".chrome-mark-badge")).toBeNull();
  });

  it("badges the chrome mark with an action-naming label when an update is ready", async () => {
    const host = fakeBridge(true);
    const { container, getAllByRole } = mount(<RennetApp bridge={host.bridge} />);
    await waitFor(() => expect(container.querySelector(".front-door")).not.toBeNull());
    host.push({ version: "0.3.0" });
    await waitFor(() =>
      expect(
        getAllByRole("button", { name: "Update ready — restart into 0.3.0" }).length,
      ).toBeGreaterThan(0),
    );
    expect(container.querySelector(".chrome-mark-badge")).not.toBeNull();
  });

  it("badges from replayed state that landed before the app subscribed late", async () => {
    // The preload replays cached readiness into the subscriber; simulate the
    // store already holding it before mount (a remount mid-session).
    useUpdateReady.getState().markReady({ version: "0.4.0" });
    const host = fakeBridge(true);
    const { getAllByRole, container } = mount(<RennetApp bridge={host.bridge} />);
    await waitFor(() => expect(container.querySelector(".front-door")).not.toBeNull());
    await waitFor(() =>
      expect(getAllByRole("button", { name: /restart into 0\.4\.0/ }).length).toBeGreaterThan(0),
    );
  });

  it("click opens the prompt; Restart now applies; the update never applies on its own", async () => {
    const host = fakeBridge(true);
    const { container, getByRole, getAllByRole } = mount(<RennetApp bridge={host.bridge} />);
    await waitFor(() => expect(container.querySelector(".front-door")).not.toBeNull());
    host.push({ version: "0.3.0" });
    await waitFor(() =>
      expect(getAllByRole("button", { name: /Update ready/ }).length).toBeGreaterThan(0),
    );
    expect(host.applied).toBe(0);
    fireEvent.click(getAllByRole("button", { name: /Update ready/ })[0] as HTMLElement);
    await waitFor(() => getByRole("dialog", { name: "Restart into 0.3.0?" }));
    fireEvent.click(getByRole("button", { name: "Restart now" }));
    expect(host.applied).toBe(1);
  });

  it("Not now closes the prompt and keeps the badge for later", async () => {
    const host = fakeBridge(true);
    const { container, getByRole, getAllByRole, queryByRole } = mount(
      <RennetApp bridge={host.bridge} />,
    );
    await waitFor(() => expect(container.querySelector(".front-door")).not.toBeNull());
    host.push({});
    await waitFor(() =>
      expect(
        getAllByRole("button", { name: "Update ready — restart to apply" }).length,
      ).toBeGreaterThan(0),
    );
    fireEvent.click(getAllByRole("button", { name: /Update ready/ })[0] as HTMLElement);
    await waitFor(() => getByRole("dialog", { name: "Restart into the update?" }));
    fireEvent.click(getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(queryByRole("dialog")).toBeNull());
    expect(host.applied).toBe(0);
    // Badge persists — the user can come back to it.
    expect(getAllByRole("button", { name: /Update ready/ }).length).toBeGreaterThan(0);
    expect(container.querySelector(".chrome-mark-badge")).not.toBeNull();
  });
});
