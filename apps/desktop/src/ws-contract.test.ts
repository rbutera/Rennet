import { WsRennetBridge } from "@rennet/client";
import { startWsListener, type WsListener } from "@rennet/server";
import { afterEach, describe, expect, it } from "vitest";

// The transport contract test (#378, design D8): two REAL WsRennetBridge clients over
// a REAL loopback listener, with a STUB dispatch. It pins framing, correlation, push
// fan-out, and reattach — NOT command behaviour (dispatch owns that in its own suite).
// This lives in apps/desktop because it is the only layer permitted to import both the
// server listener and the client bridge; packages/server may not depend on
// @rennet/client (the dependency arrows), so the two reals can only meet here.

// The stub dispatch: a progress-emitting command streams one event to its invoker;
// `session.transcript` returns rows; everything else echoes its input.
type Dispatch = Parameters<typeof startWsListener>[0]["dispatch"];
// Command names must be REAL (the session envelope validates `command` against the
// registry), but their behaviour here is stubbed — the transport, not the command, is
// under test. `project.process` stands in for a progress-emitting command.
const stubDispatch: Dispatch = (async (
  name: string,
  input: unknown,
  ctx?: {
    emitProgress?: (event: { kind: "repo-error"; repo: string; message: string }) => void;
  },
) => {
  if (name === "project.process") {
    ctx?.emitProgress?.({ kind: "repo-error", repo: "r", message: "streamed" });
    return { streamed: true };
  }
  if (name === "session.transcript") return { rows: [{ id: "t1" }] };
  return { echoed: input };
}) as Dispatch;

// Loosely-typed invoke: correlation is by requestId; the transport never inspects the
// command name or input, so the contract test uses arbitrary strings.
function invoke(bridge: WsRennetBridge, name: string, input: unknown): Promise<unknown> {
  return (bridge.invoke as unknown as (n: string, i: unknown) => Promise<unknown>)(name, input);
}

const bridges: WsRennetBridge[] = [];
const listeners: WsListener[] = [];
function connect(listener: WsListener): WsRennetBridge {
  const bridge = new WsRennetBridge({
    url: `ws://127.0.0.1:${listener.port}`,
    initialBackoffMs: 10,
  });
  bridges.push(bridge);
  return bridge;
}

async function startListener(): Promise<WsListener> {
  const listener = await startWsListener({ dispatch: stubDispatch, serverVersion: "test" });
  listeners.push(listener);
  return listener;
}

afterEach(async () => {
  for (const bridge of bridges.splice(0)) bridge.close();
  for (const listener of listeners.splice(0)) await listener.close();
});

describe("WS transport contract — real listener, real bridges (#378)", () => {
  it("serves two clients independently: per-invoke progress reaches only the invoker; broadcast reaches both", async () => {
    const listener = await startListener();
    const a = connect(listener);
    const b = connect(listener);

    const aProgress: unknown[] = [];
    const bProgress: unknown[] = [];
    // Both subscribe the invoke key; only A invokes it, so only A must receive it.
    a.onProgress("c1", (event) => aProgress.push(event));
    b.onProgress("c1", (event) => bProgress.push(event));

    const result = await invoke(a, "project.process", { commandId: "c1" });
    expect(result).toEqual({ streamed: true });
    await waitFor(() => aProgress.length === 1);
    expect(aProgress).toEqual([{ kind: "repo-error", repo: "r", message: "streamed" }]);
    // Per-invoke progress is point-to-point to the invoker; B never saw it.
    expect(bProgress).toEqual([]);

    // A background broadcast fans out to every connected socket.
    const aBroadcast: unknown[] = [];
    const bBroadcast: unknown[] = [];
    a.onProgress("bg", (event) => aBroadcast.push(event));
    b.onProgress("bg", (event) => bBroadcast.push(event));
    listener.broadcastProgress("bg", { kind: "repo-error", repo: "r", message: "rehydrate" });
    await waitFor(() => aBroadcast.length === 1 && bBroadcast.length === 1);
    expect(aBroadcast).toEqual([{ kind: "repo-error", repo: "r", message: "rehydrate" }]);
    expect(bBroadcast).toEqual([{ kind: "repo-error", repo: "r", message: "rehydrate" }]);
  });

  it("a reconnected client recovers a served read via session.transcript", async () => {
    const listener = await startListener();
    const first = connect(listener);
    expect(await invoke(first, "session.transcript", { reviewId: "rev-1" })).toEqual({
      rows: [{ id: "t1" }],
    });

    // Model a renderer reload / dropped connection: the old client goes away and a
    // fresh one handshakes against the same live listener, then reattaches. (The
    // bridge's own auto-reconnect timer is pinned in the client unit suite.)
    first.close();
    const reconnected = connect(listener);
    expect(await invoke(reconnected, "session.transcript", { reviewId: "rev-1" })).toEqual({
      rows: [{ id: "t1" }],
    });
  });

  it("a dispatched command failure comes back as a correlated rpcError", async () => {
    const listener = await startWsListener({
      dispatch: (async () => {
        throw new Error("dispatch blew up");
      }) as Dispatch,
      serverVersion: "test",
    });
    listeners.push(listener);
    const bridge = connect(listener);
    await expect(invoke(bridge, "projects.list", {})).rejects.toThrow("dispatch blew up");
  });
});

/** Poll until `predicate` holds or the timeout elapses (default 1s). */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
