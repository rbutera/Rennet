// @vitest-environment happy-dom
//
// The connections surface (#381, design D3): one component both shells mount that owns
// daemon attachment. These drive what it still OWNS after the corner switcher pill was
// removed — the default target renders the app against its own bridge, a stored daemon
// with a bad endpoint never becomes the active one, a throwing localStorage degrades to
// the default without crashing, and the daemon-lost banner below.
//
// Switching daemons and pairing one are now driven only through the capabilities context
// (`connectSource` / `pairAtAddress`); their tests live with the surfaces that call them,
// in `project/add-remote-dialog.dom.test.tsx`, over this same real shell.
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
  it("renders the app against the default target, and no corner daemon switcher", () => {
    const bridge = stubBridge();
    const createBridge = vi.fn(() => bridge);
    const { container, queryByLabelText } = mount(
      <ConnectionHost createBridge={createBridge} defaultTarget={LOCAL} />,
    );

    expect(createBridge).toHaveBeenCalledWith(LOCAL);
    // The app really mounted, so the absence below is a removed pill and not a blank
    // render silently satisfying every `query*` in this file.
    expect(container.querySelector('[data-region="sidebar"]')).toBeTruthy();
    expect(queryByLabelText(/Switch daemon/)).toBeNull();
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

  it("degrades to the default when localStorage throws", () => {
    const original = globalThis.localStorage.getItem;
    globalThis.localStorage.getItem = () => {
      throw new Error("blocked");
    };
    try {
      const bridge = stubBridge();
      const createBridge = vi.fn(() => bridge);
      mount(<ConnectionHost createBridge={createBridge} defaultTarget={LOCAL} />);
      expect(createBridge).toHaveBeenCalledWith(LOCAL);
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
    mount(<ConnectionHost createBridge={createBridge} defaultTarget={LOCAL} />);

    // It was the stored `activeId`; dropping it must fall back to the default target,
    // and it must never be dialled — not merely be missing from some list.
    await waitFor(() => expect(createBridge).toHaveBeenCalledWith(LOCAL));
    expect(createBridge).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: "daemon:corrupt" }),
    );
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
   *  `firsts[n]` is the status the n-th dial's subscribe fires immediately (the
   *  supervisor fires with its current state on subscribe); the last entry repeats for
   *  later dials. `events` records create/close ordering. */
  function scriptedConnection(...firsts: ConnectionStatus[]) {
    if (firsts.length === 0) firsts = [{ state: "online", since: 0 }];
    let emit: ((status: ConnectionStatus) => void) | undefined;
    const events: string[] = [];
    let dials = 0;
    const create = vi.fn((): Connection => {
      events.push("create");
      const first = firsts[Math.min(dials, firsts.length - 1)] as ConnectionStatus;
      dials += 1;
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

  it("keeps can't-reach wording across a Retry against a never-reached target", async () => {
    const { create, emit } = scriptedConnection({ state: "connecting", since: Date.now() });
    const { getByRole, getByText, user } = mount(
      <ConnectionHost createConnection={create} defaultTarget={LOCAL} />,
    );

    emit({ state: "error", since: Date.now(), error: "dial failed" });
    await user.click(getByText("Retry"));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));

    emit({ state: "offline", since: Date.now() });
    const text = getByRole("status").textContent ?? "";
    expect(text).toContain("Can't reach the review daemon — retrying…");
    expect(text).not.toContain("lost");
  });

  it("keeps the ever-online latch across a same-target Retry — still 'lost', and the reconnect earns its note", async () => {
    // First dial establishes; the Retry redial starts connecting (no instant handshake).
    const { create, emit } = scriptedConnection(
      { state: "online", since: 0 },
      { state: "connecting", since: 0 },
    );
    const { getByRole, getByText, user } = mount(
      <ConnectionHost createConnection={create} defaultTarget={LOCAL} />,
    );

    emit({ state: "offline", since: Date.now() });
    emit({ state: "error", since: Date.now(), error: "handshake rejected" });
    await user.click(getByText("Retry"));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));

    // Still down after the redial: this daemon WAS reached — the copy must say lost,
    // not imply it never existed.
    emit({ state: "offline", since: Date.now() });
    expect(getByRole("status").textContent).toContain("Connection to the review daemon lost");

    // And when it comes back, the established-connection latch earns the note.
    emit({ state: "online", since: Date.now() });
    expect(getByRole("status").textContent).toContain("Reconnected to the review daemon.");
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
    // The fresh connection reports online (its subscribe fires immediately), so the SAME
    // banner swaps from the failure to the reconnected note. (The old assertion here read
    // the corner indicator's "Connected to …" label, which was true alongside the banner,
    // not instead of it — the banner is what this redial actually changes.)
    expect(getByRole("status").textContent).toContain("Reconnected to the review daemon.");
  });
});
