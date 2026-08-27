// @vitest-environment happy-dom
//
// C10 §3 — the Environments page over the settings projection. Local card has no
// Remove (This Machine is where Rennet runs); a remote rename flows through the ONE
// hosts state to a second reader (proof it is the seam, not a local copy); the three
// daemon states render from the projection; the Remove confirmation names the project
// + session counts and states the machine is untouched.
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { BridgeProvider } from "../../data";
import { cleanup, mount, within } from "../../test/dom";
import { MemoryBridge } from "../../test/memory-bridge";
import {
  EMPTY_SETTINGS_PROJECTION,
  type SettingsHost,
  type SettingsProjection,
  SettingsProjectionProvider,
} from "../data";
import { EnvironmentsPage } from "./environments-page";

const LOCAL: SettingsHost = {
  id: "local",
  name: "This Machine",
  kind: "local",
  os: "macos",
  daemon: { reachable: true, version: "1.0.1" },
};

/** A stateful projection: renameHost updates the one hosts array, so every reader of
 *  the context (the page AND the probe below) re-renders with the new name. */
function StatefulEnvironments({ initial }: { readonly initial: readonly SettingsHost[] }) {
  const [hosts, setHosts] = useState(initial);
  const projection: SettingsProjection = {
    ...EMPTY_SETTINGS_PROJECTION,
    hosts,
    renameHost: (id, name) =>
      setHosts((prev) => prev.map((h) => (h.id === id ? { ...h, name } : h))),
    removeHost: (id) => setHosts((prev) => prev.filter((h) => h.id !== id)),
  };
  return (
    <BridgeProvider bridge={new MemoryBridge({}, { platform: "darwin", version: "1.0.1" })}>
      <SettingsProjectionProvider value={projection}>
        <EnvironmentsPage />
        <div data-testid="probe">{hosts.map((h) => h.name).join("|")}</div>
      </SettingsProjectionProvider>
    </BridgeProvider>
  );
}

function card(host: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(`[data-host="${host}"]`);
  if (!node) throw new Error(`host card ${host} not found`);
  return node;
}

describe("EnvironmentsPage — cards + daemon", () => {
  it("the local card offers Rename but never Remove", () => {
    const { getByRole, queryByRole } = mount(<StatefulEnvironments initial={[LOCAL]} />);
    expect(getByRole("button", { name: "Rename This Machine" })).toBeTruthy();
    expect(queryByRole("button", { name: "Remove This Machine" })).toBeNull();
    cleanup();
  });

  it("a live local card is synthesized from the bridge when the projection is empty", () => {
    const { getByText } = mount(
      <BridgeProvider bridge={new MemoryBridge({}, { platform: "darwin", version: "1.0.1" })}>
        <SettingsProjectionProvider value={EMPTY_SETTINGS_PROJECTION}>
          <EnvironmentsPage />
        </SettingsProjectionProvider>
      </BridgeProvider>,
    );
    expect(getByText("This Machine")).toBeTruthy();
    expect(getByText("Rennet daemon v1.0.1")).toBeTruthy();
    cleanup();
  });

  it("a remote rename flows through the one hosts state to a second reader", async () => {
    const remote: SettingsHost = {
      id: "h2",
      name: "dev-box",
      kind: "remote",
      os: "linux",
      address: "dev-box.tailnet.ts.net",
      daemon: { reachable: true, version: "1.0.0" },
    };
    const { getByRole, getByLabelText, getByTestId, user } = mount(
      <StatefulEnvironments initial={[LOCAL, remote]} />,
    );
    expect(getByTestId("probe").textContent).toBe("This Machine|dev-box");

    await user.click(getByRole("button", { name: "Rename dev-box" }));
    const input = getByLabelText("Environment name");
    await user.clear(input);
    await user.type(input, "gpu-rig{Enter}");

    // The SAME state the probe reads updated — one hosts state, not a local copy.
    expect(getByTestId("probe").textContent).toBe("This Machine|gpu-rig");
    cleanup();
  });

  it("renders the three daemon states honestly", () => {
    const hosts: readonly SettingsHost[] = [
      LOCAL,
      {
        id: "h2",
        name: "dev-box",
        kind: "remote",
        os: "linux",
        daemon: { reachable: false, lastSeenVersion: "1.0.0" },
      },
      {
        id: "h3",
        name: "gpu-01",
        kind: "remote",
        os: "wsl",
        daemon: { reachable: false },
      },
    ];
    const { getByText } = mount(<StatefulEnvironments initial={hosts} />);
    expect(getByText("Rennet daemon v1.0.1")).toBeTruthy();
    expect(getByText("Not connected — last seen running Rennet daemon v1.0.0")).toBeTruthy();
    expect(getByText("Not connected — daemon unreachable, version unknown")).toBeTruthy();
    // Reconnect shows only on the unreachable cards; the reachable local has none.
    expect(within(card("h2")).getByRole("button", { name: "Reconnect" })).toBeTruthy();
    expect(within(card("local")).queryByRole("button", { name: "Reconnect" })).toBeNull();
    cleanup();
  });

  it("the Remove confirmation names the project + session counts, machine untouched", async () => {
    const remote: SettingsHost = {
      id: "h2",
      name: "dev-box",
      kind: "remote",
      os: "linux",
      daemon: { reachable: true, version: "1.0.0" },
      projectCount: 2,
      sessionCount: 5,
    };
    const { getByRole, findByText, user } = mount(
      <StatefulEnvironments initial={[LOCAL, remote]} />,
    );
    await user.click(getByRole("button", { name: "Remove dev-box" }));
    await findByText(/This removes the environment, its 2 projects and 5 sessions/);
    await findByText(/The machine itself is not touched\./);
    cleanup();
  });
});
