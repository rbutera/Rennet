// @vitest-environment happy-dom
//
// C10 §2 — the settings data seam. Three proofs: (1) a LIVE write persists to the
// bridge and a re-read reflects it (the appearance scheme through `settings.setAppearance`,
// with the provenance rung moving builtin → global); (2) the `{ value, layer }` keep
// contract lifts into the shared chip's `ResolvedProvenance`; (3) the B10-absent
// projection resolves through its context — honest-empty by default, stateful when a
// test supplies it. No page reaches a fixture directly; data enters only through the
// bridge context or the projection provider.
import type { ResolvedProvenance } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { BridgeProvider } from "../../data";
import { cleanup, mount, waitFor } from "../../test/dom";
import { settingsBridge } from "../../test/fixtures/settings";
import { MemoryBridge } from "../../test/memory-bridge";
import { AppearancePage } from "../appearance";
import {
  EMPTY_SETTINGS_PROJECTION,
  type SettingsHost,
  SettingsProjectionProvider,
  toProvenance,
  useSettingsProjection,
} from ".";

describe("settings data seam — live writes persist to the bridge", () => {
  it("a scheme change persists and the provenance rung moves builtin → global", async () => {
    const { getByRole, findByText, container, user } = mount(
      <BridgeProvider bridge={settingsBridge({ scheme: "system" })}>
        <AppearancePage />
      </BridgeProvider>,
    );

    // Starts at the builtin default — the chip reads `builtin`.
    await waitFor(() =>
      expect(container.querySelector('[data-slot="provenance-chip"]')).toBeTruthy(),
    );
    expect(
      container.querySelector('[data-slot="provenance-chip"]')?.getAttribute("data-layer"),
    ).toBe("builtin");

    // Choose Dark — the write hits `settings.setAppearance`, invalidates `settings.get`,
    // and the re-read shows the value now resolved from the GLOBAL rung.
    await user.click(getByRole("button", { name: "Dark" }));
    await findByText("global: dark");
    await waitFor(() =>
      expect(
        container.querySelector('[data-slot="provenance-chip"]')?.getAttribute("data-layer"),
      ).toBe("global"),
    );
    cleanup();
  });

  it("the scheme write survives a remount of the SAME bridge (packet §12.3)", async () => {
    // One stateful bridge instance across two mounts — the real persistence contract:
    // a `settings.setAppearance` write must still be there when the page mounts again
    // (over MemoryBridge now; over the split `client-settings.json` at the B10 fold).
    const bridge = settingsBridge({ scheme: "system" });

    const first = mount(
      <BridgeProvider bridge={bridge}>
        <AppearancePage />
      </BridgeProvider>,
    );
    // The scheme control renders once the live read resolves (loading is its own state).
    await first.user.click(await first.findByRole("button", { name: "Dark" }));
    await first.findByText("global: dark");
    first.unmount();
    cleanup();

    // Remount over the SAME bridge — the persisted Dark scheme resolves from the global
    // rung on a fresh `settings.get`, with no second write.
    const second = mount(
      <BridgeProvider bridge={bridge}>
        <AppearancePage />
      </BridgeProvider>,
    );
    await second.findByText("global: dark");
    await waitFor(() =>
      expect(
        second.container.querySelector('[data-slot="provenance-chip"]')?.getAttribute("data-layer"),
      ).toBe("global"),
    );
    cleanup();
  });
});

describe("AppearancePage — reset-to-builtin, read/write states, backing files (P2-6/7/8)", () => {
  it("a global scheme offers Reset, which clears it back to the builtin (P2-6)", async () => {
    const { container, findByRole, queryByRole, user } = mount(
      <BridgeProvider bridge={settingsBridge({ scheme: "dark" })}>
        <AppearancePage />
      </BridgeProvider>,
    );
    // A global override resolves ⇒ the Reset control appears.
    const reset = await findByRole("button", { name: "Reset appearance to the system default" });
    await waitFor(() =>
      expect(
        container.querySelector('[data-slot="provenance-chip"]')?.getAttribute("data-layer"),
      ).toBe("global"),
    );
    // Reset sends `scheme: null` — the value falls back to the builtin and Reset disappears.
    await user.click(reset);
    await waitFor(() =>
      expect(
        container.querySelector('[data-slot="provenance-chip"]')?.getAttribute("data-layer"),
      ).toBe("builtin"),
    );
    expect(queryByRole("button", { name: "Reset appearance to the system default" })).toBeNull();
    cleanup();
  });

  it("a failed appearance WRITE is disclosed, not silently swallowed (P2-6)", async () => {
    const bridge = new MemoryBridge({
      "settings.get": () => ({
        scheme: "system",
        schemeProvenance: {
          layer: "builtin",
          contributions: [{ layer: "builtin", value: "system", effective: true }],
        },
        appearanceMalformed: false,
        projects: [],
      }),
      "settings.setAppearance": () => {
        throw new Error("disk full");
      },
    });
    const { findByRole, findByText, user } = mount(
      <BridgeProvider bridge={bridge}>
        <AppearancePage />
      </BridgeProvider>,
    );
    await user.click(await findByRole("button", { name: "Dark" }));
    expect(await findByText(/The write failed: disk full/)).toBeTruthy();
    cleanup();
  });

  it("a failed live READ shows an error state, not a false System default (P2-7)", async () => {
    const bridge = new MemoryBridge({
      "settings.get": () => {
        throw new Error("daemon down");
      },
    });
    const { findByText } = mount(
      <BridgeProvider bridge={bridge}>
        <AppearancePage />
      </BridgeProvider>,
    );
    expect(await findByText(/Couldn’t read settings: daemon down/)).toBeTruthy();
    cleanup();
  });

  it("an in-flight read shows Loading, distinct from a loaded empty (P2-7)", async () => {
    // A never-resolving handler keeps the read pending — the honest loading state.
    // A promise that never settles keeps the read pending (the honest loading state).
    const neverSettles = new Promise<never>(() => undefined);
    const bridge = new MemoryBridge({ "settings.get": () => neverSettles });
    const { findByText } = mount(
      <BridgeProvider bridge={bridge}>
        <AppearancePage />
      </BridgeProvider>,
    );
    expect(await findByText("Loading…")).toBeTruthy();
    cleanup();
  });

  it("names client-settings.json as the backing file; theme sections are session-only (P2-8)", async () => {
    const { findByText, container } = mount(
      <BridgeProvider bridge={settingsBridge({ scheme: "light" })}>
        <AppearancePage />
      </BridgeProvider>,
    );
    await findByText("Theme Pack");
    const backings = [...container.querySelectorAll('[data-slot="backing-file"]')].map(
      (n) => n.textContent,
    );
    // The Appearance section names the REAL live store; no section names the legacy config.json.
    expect(backings).toContain("~/.rennet/client-settings.json");
    expect(backings.some((t) => t?.includes("config.json"))).toBe(false);
    // Theme Pack + Code Theme carry no backing file — they are session-only.
    expect(container.querySelectorAll('[data-slot="session-only"]').length).toBe(2);
    cleanup();
  });
});

describe("toProvenance — the {value, layer} keep contract lifts into the chip shape", () => {
  it("wraps one layered value as a single effective contribution", () => {
    const p: ResolvedProvenance = toProvenance({ value: "git-visible", layer: "repo" });
    expect(p.layer).toBe("repo");
    expect(p.contributions).toEqual([{ layer: "repo", value: "git-visible", effective: true }]);
  });
});

describe("settings projection — B10-absent reads resolve through the context", () => {
  function HostNames() {
    const { hosts } = useSettingsProjection();
    return <div data-testid="hosts">{hosts.map((h) => h.name).join(",")}</div>;
  }

  it("is honest-empty by default (the live client, no B10 engine)", () => {
    expect(EMPTY_SETTINGS_PROJECTION.hosts).toEqual([]);
    const { getByTestId } = mount(<HostNames />);
    expect(getByTestId("hosts").textContent).toBe("");
    cleanup();
  });

  it("yields the supplied hosts when a test provides a projection", () => {
    const hosts: readonly SettingsHost[] = [
      {
        id: "local",
        name: "This Machine",
        kind: "local",
        os: "macos",
        daemon: { reachable: true },
      },
      {
        id: "h2",
        name: "dev-box",
        kind: "remote",
        os: "linux",
        address: "dev-box.tailnet.ts.net",
        daemon: { reachable: true, version: "1.0.0" },
      },
    ];
    const { getByTestId } = mount(
      <SettingsProjectionProvider value={{ ...EMPTY_SETTINGS_PROJECTION, hosts }}>
        <HostNames />
      </SettingsProjectionProvider>,
    );
    expect(getByTestId("hosts").textContent).toBe("This Machine,dev-box");
    cleanup();
  });
});
