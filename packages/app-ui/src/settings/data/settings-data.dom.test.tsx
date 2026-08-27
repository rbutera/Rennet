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
