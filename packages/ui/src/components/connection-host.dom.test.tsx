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

// ─────────────────────────────────────────────────────────────────────────────
// The daemon-lost banner (PR #405 follow-up). Field-diagnosed failure: the daemon
// crashed, the renderer's queue-mode invokes waited forever, and every surface sat
// on innocent loading copy with zero indication the daemon was gone. The banner is
// the honest disclosure — these pin its appearance and exact `since` anchoring, its
// persistence through the retry oscillation (the original anchor survives newer
// transitions), the never-online honesty split (a cold boot against an unreachable
// daemon says "can't reach", never "lost", and clears silently on first handshake),
// the self-clearing reconnected note, and the terminal-error Retry re-dial (which
// closes the dead connection exactly once before dialing afresh). Reverting the
// ConnectionHost wiring must red these.
// ─────────────────────────────────────────────────────────────────────────────
describe("ConnectionHost — daemon-lost banner (PR #405 follow-up)", () => {
  /** A supervisor-backed connection stub whose reachability the test scripts.
   *  `first` is the status the subscribe fires immediately (the supervisor fires with
   *  its current state on subscribe); `events` records create/close ordering. */
  function scriptedConnection(first: ConnectionStatus = { state: "online", since: 0 }) {
    let emit: ((status: ConnectionStatus) => void) | undefined;
    const events: string[] = [];
    const create = vi.fn((): Connection => {
      events.push("create");
      return {
        bridge: stubBridge(),
        subscribe: (listener) => {
          emit = listener;
          listener(first);
          return () => undefined;
        },
        close: () => void events.push("close"),
      };
    });
    return { create, events, emit: (status: ConnectionStatus) => act(() => emit?.(status)) };
  }

  it("anchors the lost banner to the drop's `since` and ticks elapsed from it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    try {
      const { create, emit } = scriptedConnection();
      const { container, getByRole } = mount(
        <ConnectionHost createConnection={create} defaultTarget={LOCAL} />,
      );

      // Online: no banner. The initial connect is the indicator's job, not a banner.
      expect(container.querySelector(".connection-banner")).toBeNull();

      // The socket dropped 5s before the transition was delivered: elapsed reads the
      // anchor, not the delivery time.
      emit({ state: "offline", since: 95_000 });
      expect(getByRole("status").textContent).toBe(
        "Connection to the review daemon lost — reconnecting… (5s)",
      );
      act(() => vi.advanceTimersByTime(3000));
      expect(getByRole("status").textContent).toBe(
        "Connection to the review daemon lost — reconnecting… (8s)",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds the ORIGINAL anchor through the connecting/offline retry oscillation", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    try {
      const { create, emit } = scriptedConnection();
      const { getByRole } = mount(
        <ConnectionHost createConnection={create} defaultTarget={LOCAL} />,
      );

      emit({ state: "offline", since: 100_000 });
      act(() => vi.advanceTimersByTime(15_000));
      // Each retry attempt carries a NEWER `since`; the banner must not re-anchor.
      emit({ state: "connecting", since: 115_000 });
      emit({ state: "offline", since: 115_000 });
      expect(getByRole("status").textContent).toBe(
        "Connection to the review daemon lost — reconnecting… (15s)",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("never claims 'lost' for a connection that never existed — cold boot says can't-reach, first handshake clears silently", () => {
    // ws-bridge maps a failed INITIAL dial to lifecycle "offline" too, so a slow or
    // unreachable daemon at boot lands here without any established connection.
    const { create, emit } = scriptedConnection({ state: "connecting", since: Date.now() });
    const { container, getByRole, queryByText } = mount(
      <ConnectionHost createConnection={create} defaultTarget={LOCAL} />,
    );

    emit({ state: "offline", since: Date.now() });
    const banner = getByRole("status");
    expect(banner.textContent).toContain("Can't reach the review daemon — retrying…");
    expect(banner.textContent).not.toContain("lost");

    // First successful handshake: no "Reconnected" note for a never-established
    // connection — the banner just goes away.
    emit({ state: "online", since: Date.now() });
    expect(container.querySelector(".connection-banner")).toBeNull();
    expect(queryByText(/Reconnected/)).toBeNull();
  });

  it("swaps to a reconnected note when an ESTABLISHED connection comes back, which clears itself", () => {
    vi.useFakeTimers();
    try {
      const { create, emit } = scriptedConnection();
      const { container, getByRole } = mount(
        <ConnectionHost createConnection={create} defaultTarget={LOCAL} />,
      );

      emit({ state: "offline", since: Date.now() });
      emit({ state: "online", since: Date.now() });
      expect(getByRole("status").textContent).toContain("Reconnected to the review daemon.");

      act(() => vi.advanceTimersByTime(4100));
      expect(container.querySelector(".connection-banner")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says a terminal error plainly and Retry closes the dead connection, then re-dials", async () => {
    const { create, events, emit } = scriptedConnection();
    const { getByRole, getByText, user } = mount(
      <ConnectionHost createConnection={create} defaultTarget={LOCAL} />,
    );
    expect(events).toEqual(["create"]);

    emit({ state: "error", since: Date.now(), error: "device token was revoked" });
    expect(getByRole("status").textContent).toContain(
      "Connection to the review daemon failed: device token was revoked",
    );

    await user.click(getByText("Retry"));
    // The re-dial seam: exactly one close of the dead connection BEFORE the fresh dial.
    await waitFor(() => expect(events).toEqual(["create", "close", "create"]));
    // The fresh connection reports online (its subscribe fires immediately): banner gone.
    expect(getByRole("button", { name: /Connected to This machine/ })).toBeTruthy();
  });
});
