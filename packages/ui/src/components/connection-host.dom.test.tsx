// @vitest-environment happy-dom
//
// The connections surface (#381, design D3): one component both shells mount that owns
// daemon attachment. These drive the surfaces that carry the contract — the default
// target renders the app, a switch remounts against a new bridge (closing the old), the
// add-daemon flow exchanges a pairing code through a temporary bridge and persists the
// tokened daemon, and a throwing localStorage degrades to the default without crashing.
import type { CommandName, RennetBridge } from "@rennet/protocol";
import { describe, expect, it, type Mock, vi } from "vitest";
import { mount, waitFor } from "../test/dom";
import { ConnectionHost, type ConnectionTarget } from "./connection-host";

const LOCAL: ConnectionTarget = { id: "local", label: "This machine", host: "127.0.0.1" };

/** A stub bridge: pending invokes (RennetApp stays in its loading state), plus a close spy. */
function stubBridge(
  overrides?: Partial<Record<CommandName, unknown>>,
): RennetBridge & { close: Mock<() => void> } {
  return {
    invoke: vi.fn((name: CommandName) => {
      if (overrides && name in overrides) return Promise.resolve(overrides[name]);
      return new Promise(() => undefined); // never resolves — no error path, no crash
    }) as RennetBridge["invoke"],
    close: vi.fn<() => void>(),
  };
}

describe("ConnectionHost (#381)", () => {
  it("renders the app against the default target and names it", () => {
    const bridge = stubBridge();
    const createBridge = vi.fn(() => bridge);
    const { getByLabelText } = mount(
      <ConnectionHost createBridge={createBridge} defaultTarget={LOCAL} />,
    );

    expect(createBridge).toHaveBeenCalledWith(LOCAL);
    expect(getByLabelText(/Connected to This machine/)).toBeTruthy();
  });

  it("switches to a saved daemon by remounting against a new bridge and closing the old", async () => {
    globalThis.localStorage.setItem(
      "rennet.daemons",
      JSON.stringify({
        daemons: [
          {
            id: "daemon:remote-1",
            label: "Laptop",
            host: "100.1.2.3",
            port: 7411,
            deviceToken: "tok-1",
          },
        ],
      }),
    );
    const local = stubBridge();
    const remote = stubBridge();
    const createBridge = vi.fn((target: ConnectionTarget) =>
      target.id === "local" ? local : remote,
    );

    const { getByLabelText, getByText, user } = mount(
      <ConnectionHost createBridge={createBridge} defaultTarget={LOCAL} />,
    );

    await user.click(getByLabelText(/Switch daemon/));
    await user.click(getByText(/Laptop/));

    await waitFor(() =>
      expect(createBridge).toHaveBeenCalledWith(expect.objectContaining({ id: "daemon:remote-1" })),
    );
    expect(local.close).toHaveBeenCalled();
  });

  it("adds a daemon by exchanging the pairing code and persisting the tokened target", async () => {
    const local = stubBridge();
    const pairing = stubBridge({
      "pairing.exchange": { deviceToken: "new-token", deviceId: "dev-9" },
    });
    const createBridge = vi.fn((target: ConnectionTarget) =>
      target.id.startsWith("pairing:") ? pairing : local,
    );

    const { getByLabelText, getByText, getByPlaceholderText, user } = mount(
      <ConnectionHost createBridge={createBridge} defaultTarget={LOCAL} />,
    );

    await user.click(getByLabelText(/Switch daemon/));
    await user.click(getByText(/Add a daemon/));
    await user.type(getByPlaceholderText(/or host:port/), "100.9.9.9:7411");
    await user.type(getByPlaceholderText(/8 characters/), "ABCD2345");
    await user.click(getByText(/Pair and add/));

    await waitFor(() =>
      expect(pairing.invoke).toHaveBeenCalledWith("pairing.exchange", {
        code: "ABCD2345",
        deviceName: "100.9.9.9",
      }),
    );
    await waitFor(() => {
      const stored = JSON.parse(globalThis.localStorage.getItem("rennet.daemons") ?? "{}");
      expect(stored.daemons).toEqual([
        {
          id: "daemon:dev-9",
          label: "100.9.9.9",
          host: "100.9.9.9",
          port: 7411,
          deviceToken: "new-token",
        },
      ]);
    });
    expect(pairing.close).toHaveBeenCalled();
  });

  it("degrades to the default when localStorage throws", () => {
    const original = globalThis.localStorage.getItem;
    globalThis.localStorage.getItem = () => {
      throw new Error("blocked");
    };
    try {
      const bridge = stubBridge();
      const { getByLabelText } = mount(
        <ConnectionHost createBridge={() => bridge} defaultTarget={LOCAL} />,
      );
      expect(getByLabelText(/Connected to This machine/)).toBeTruthy();
    } finally {
      globalThis.localStorage.getItem = original;
    }
  });
});
