// @vitest-environment happy-dom
//
// C10 §11 salvage — device pairing (#380), moved off the deleted settings-screen onto
// This Machine's Environments card. Pairing rides the LIVE `pairing.*` backend through
// the data seam: mint shows a one-time code, the paired-devices list renders, and
// revoke drops a device (the revoke mutation invalidates `pairing.listDevices`, so the
// one list re-reads). Pairing bootstraps a connection to THIS daemon, so it appears on
// the local card only — never on a remote card.
import type { PairedDevice } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { BridgeProvider } from "../../data";
import { cleanup, mount, waitFor, within } from "../../test/dom";
import { MemoryBridge, type MemoryBridgeHandlers } from "../../test/memory-bridge";
import { EMPTY_SETTINGS_PROJECTION, type SettingsHost, SettingsProjectionProvider } from "../data";
import { EnvironmentsPage } from "./environments-page";

const LOCAL: SettingsHost = {
  id: "local",
  name: "This Machine",
  kind: "local",
  os: "macos",
  daemon: { reachable: true, version: "1.0.1" },
};

const REMOTE: SettingsHost = {
  id: "h2",
  name: "dev-box",
  kind: "remote",
  os: "linux",
  address: "dev-box.tailnet.ts.net",
  daemon: { reachable: true, version: "1.0.0" },
};

function device(over: Partial<PairedDevice> = {}): PairedDevice {
  return {
    deviceId: "d1",
    name: "iPhone",
    createdAt: "2026-08-01T00:00:00.000Z",
    lastSeenAt: "2026-08-27T00:00:00.000Z",
    expiresAt: "2026-12-01T00:00:00.000Z",
    ...over,
  };
}

/** A stateful pairing backend: listDevices reflects mints/revokes; mint returns a code. */
function pairingHandlers(seed: readonly PairedDevice[] = []): MemoryBridgeHandlers {
  let devices = [...seed];
  return {
    "pairing.listDevices": () => ({ devices: [...devices] }),
    "pairing.mint": () => ({ code: "ABCD-1234", expiresAt: "2026-08-27T00:05:00.000Z" }),
    "pairing.revokeDevice": ({ deviceId }) => {
      devices = devices.filter((d) => d.deviceId !== deviceId);
      return { devices: [...devices] };
    },
  };
}

function mountEnvironments(hosts: readonly SettingsHost[], handlers: MemoryBridgeHandlers) {
  return mount(
    <BridgeProvider bridge={new MemoryBridge(handlers, { platform: "darwin", version: "1.0.1" })}>
      <SettingsProjectionProvider value={{ ...EMPTY_SETTINGS_PROJECTION, hosts }}>
        <EnvironmentsPage />
      </SettingsProjectionProvider>
    </BridgeProvider>,
  );
}

function card(host: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(`[data-host="${host}"]`);
  if (!node) throw new Error(`host card ${host} not found`);
  return node;
}

describe("PairingSection — device pairing on the local Environments card", () => {
  it("appears on the local card only, never on a remote card", () => {
    mountEnvironments([LOCAL, REMOTE], pairingHandlers());
    expect(within(card("local")).getByText("Device Pairing")).toBeTruthy();
    expect(within(card("h2")).queryByText("Device Pairing")).toBeNull();
    cleanup();
  });

  it("mints a one-time code on demand", async () => {
    const { getByRole, findByText } = mountEnvironments([LOCAL], pairingHandlers());
    getByRole("button", { name: "Create pairing code" }).click();
    await findByText("ABCD-1234");
    cleanup();
  });

  it("lists paired devices and revokes one through the invalidating mutation", async () => {
    const { findByText, getByRole, queryByText } = mountEnvironments(
      [LOCAL],
      pairingHandlers([device({ deviceId: "d1", name: "iPhone" })]),
    );
    // The seeded device renders (the live list read resolved).
    await findByText("iPhone");
    getByRole("button", { name: "Revoke iPhone" }).click();
    // Revoke invalidated `pairing.listDevices`; the re-read drops the device.
    await waitFor(() => expect(queryByText("iPhone")).toBeNull());
    await findByText("No devices paired yet.");
    cleanup();
  });
});
