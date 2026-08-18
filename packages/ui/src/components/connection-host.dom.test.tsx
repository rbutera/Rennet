// @vitest-environment happy-dom
//
// The connections surface (#381, design D3): one component both shells mount that owns
// daemon attachment. These drive the surfaces that carry the contract — the default
// target renders the app, a switch remounts against a new bridge (closing the old), the
// add-daemon flow exchanges a pairing code through a temporary bridge and persists the
// tokened daemon, and a throwing localStorage degrades to the default without crashing.
import type { CommandName, RennetBridge } from "@rennet/protocol";
import { StrictMode } from "react";
import { describe, expect, it, type Mock, vi } from "vitest";
import { act, mount, waitFor } from "../test/dom";
import {
  type Connection,
  ConnectionHost,
  type ConnectionStatus,
  type ConnectionTarget,
} from "./connection-host";

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

  it("hydrates the default target with a saved token for the same authority", async () => {
    globalThis.localStorage.setItem(
      "rennet.daemons",
      JSON.stringify({
        daemons: [
          {
            id: "daemon:served-origin",
            label: "Served origin",
            host: "rennet.tailnet.ts.net",
            port: 7411,
            deviceToken: "served-origin-token",
          },
        ],
      }),
    );
    const bridge = stubBridge();
    const createBridge = vi.fn(() => bridge);
    const servedOrigin: ConnectionTarget = {
      id: "local",
      label: "This server",
      host: "rennet.tailnet.ts.net",
      port: 7411,
    };

    mount(<ConnectionHost createBridge={createBridge} defaultTarget={servedOrigin} />);

    await waitFor(() =>
      expect(createBridge).toHaveBeenCalledWith({
        ...servedOrigin,
        deviceToken: "served-origin-token",
      }),
    );
  });

  it("does not leak or retain the closed render-pass bridge under StrictMode", async () => {
    const discarded = stubBridge();
    const live = stubBridge();
    const createBridge = vi.fn().mockReturnValueOnce(discarded).mockReturnValue(live);

    mount(
      <StrictMode>
        <ConnectionHost createBridge={createBridge} defaultTarget={LOCAL} />
      </StrictMode>,
    );

    await waitFor(() => expect(createBridge).toHaveBeenCalledTimes(2));
    expect(discarded.close).toHaveBeenCalledTimes(1);
    expect(live.close).not.toHaveBeenCalled();
    await waitFor(() => expect(live.invoke).toHaveBeenCalled());
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
    expect(JSON.parse(globalThis.localStorage.getItem("rennet.daemons") ?? "{}").activeId).toBe(
      "daemon:remote-1",
    );
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

  it("announces the connection state truthfully — offline, not 'Connected' (#383)", async () => {
    let emit: ((status: ConnectionStatus) => void) | undefined;
    const createConnection = (): Connection => ({
      bridge: stubBridge(),
      subscribe: (listener) => {
        emit = listener;
        listener({ state: "online" }); // starts connected
        return () => undefined;
      },
      close: () => undefined,
    });
    const { getByLabelText, queryByLabelText } = mount(
      <ConnectionHost createConnection={createConnection} defaultTarget={LOCAL} />,
    );
    // Online: the plain connected label (unchanged from the legacy path).
    await waitFor(() => expect(getByLabelText(/Connected to This machine/)).toBeTruthy());
    // Socket drops → the indicator says offline/reconnecting, never a false "Connected".
    act(() => emit?.({ state: "offline" }));
    await waitFor(() =>
      expect(getByLabelText(/Offline from This machine, reconnecting/)).toBeTruthy(),
    );
    expect(queryByLabelText(/Connected to This machine/)).toBeNull();
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

  it("silently ignores a stored daemon with an invalid endpoint", async () => {
    globalThis.localStorage.setItem(
      "rennet.daemons",
      JSON.stringify({
        daemons: [
          {
            id: "daemon:corrupt",
            label: "Corrupt daemon",
            host: "example.com",
            port: 70_000,
            deviceToken: "bad-token",
          },
        ],
        activeId: "daemon:corrupt",
      }),
    );
    const bridge = stubBridge();
    const createBridge = vi.fn(() => bridge);
    const { getByLabelText, queryByText, user } = mount(
      <ConnectionHost createBridge={createBridge} defaultTarget={LOCAL} />,
    );

    await waitFor(() => expect(createBridge).toHaveBeenCalledWith(LOCAL));
    await user.click(getByLabelText(/Switch daemon/));
    expect(queryByText("Corrupt daemon")).toBeNull();
  });

  it("rejects an out-of-range port without leaving the pairing form busy", async () => {
    const bridge = stubBridge();
    const createBridge = vi.fn(() => bridge);
    const { getByLabelText, getByPlaceholderText, getByRole, getByText, user } = mount(
      <ConnectionHost createBridge={createBridge} defaultTarget={LOCAL} />,
    );

    await user.click(getByLabelText(/Switch daemon/));
    await user.click(getByText(/Add a daemon/));
    await user.type(getByPlaceholderText(/or host:port/), "host:70000");
    await user.type(getByPlaceholderText(/8 characters/), "ABCD2345");
    await user.click(getByText(/Pair and add/));

    expect(getByRole("alert").textContent).toContain("Enter a host");
    expect((getByText("Pair and add") as HTMLButtonElement).disabled).toBe(false);
    expect(createBridge).toHaveBeenCalledTimes(1);
  });

  it("clears the pairing busy state when temporary bridge construction throws", async () => {
    const bridge = stubBridge();
    const createBridge = vi.fn((target: ConnectionTarget) => {
      if (target.id.startsWith("pairing:")) throw new Error("bridge construction failed");
      return bridge;
    });
    const { getByLabelText, getByPlaceholderText, getByRole, getByText, user } = mount(
      <ConnectionHost createBridge={createBridge} defaultTarget={LOCAL} />,
    );

    await user.click(getByLabelText(/Switch daemon/));
    await user.click(getByText(/Add a daemon/));
    await user.type(getByPlaceholderText(/or host:port/), "host:7411");
    await user.type(getByPlaceholderText(/8 characters/), "ABCD2345");
    await user.click(getByText(/Pair and add/));

    expect(getByRole("alert").textContent).toContain("bridge construction failed");
    expect((getByText("Pair and add") as HTMLButtonElement).disabled).toBe(false);
  });
});
