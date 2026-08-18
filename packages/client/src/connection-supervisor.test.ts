import type { AddressInfo } from "node:net";
import type { ProjectProcessEvent, ReviewAskStreamEvent } from "@rennet/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import {
  type BridgeHooks,
  ConnectionError,
  ConnectionSupervisor,
  type SupervisedBridge,
} from "./connection-supervisor";
import type { StoredReplica } from "./stores";
import { WsRennetBridge } from "./ws-bridge";

// ─────────────────────────────────────────────────────────────────────────────
// A scriptable in-memory bridge so the state machine, registry, stores, and presence
// are pinned deterministically (no sockets). The factory records every bridge it makes,
// so a test drives the LATEST one — that is the whole point of the swap tests.
// ─────────────────────────────────────────────────────────────────────────────
class FakeBridge implements SupervisedBridge {
  serverInfo = null;
  closed = false;
  readonly invokes: Array<{ name: string; input: unknown }> = [];
  readonly askListeners = new Map<string, Set<(e: ReviewAskStreamEvent) => void>>();
  readonly progressListeners = new Map<string, Set<(e: ProjectProcessEvent) => void>>();
  invokeImpl: (name: string, input: unknown) => Promise<unknown> = () => Promise.resolve({});

  constructor(
    readonly hooks: BridgeHooks,
    readonly token: string | undefined,
  ) {}

  invoke(name: string, input: unknown): Promise<never> {
    this.invokes.push({ name, input });
    return this.invokeImpl(name, input) as Promise<never>;
  }
  onAskStream(reviewId: string, listener: (e: ReviewAskStreamEvent) => void): () => void {
    return add(this.askListeners, reviewId, listener);
  }
  onProgress(commandId: string, listener: (e: ProjectProcessEvent) => void): () => void {
    return add(this.progressListeners, commandId, listener);
  }
  close(): void {
    this.closed = true;
  }

  goOnline(): void {
    this.hooks.onLifecycle({ kind: "online" });
  }
  goOffline(): void {
    this.hooks.onLifecycle({ kind: "offline" });
  }
  goError(reason: string): void {
    this.hooks.onLifecycle({ kind: "error", reason });
  }
  emitAsk(reviewId: string, event: ReviewAskStreamEvent): void {
    for (const l of this.askListeners.get(reviewId) ?? []) l(event);
  }
}

function add<L>(map: Map<string, Set<L>>, key: string, listener: L): () => void {
  let set = map.get(key);
  if (!set) {
    set = new Set<L>();
    map.set(key, set);
  }
  set.add(listener);
  return () => set?.delete(listener);
}

/** A supervisor wired to a FakeBridge factory; returns the supervisor + the bridge list. */
function makeSupervisor(
  options: Partial<ConstructorParameters<typeof ConnectionSupervisor>[0]> = {},
): { supervisor: ConnectionSupervisor; bridges: FakeBridge[] } {
  const bridges: FakeBridge[] = [];
  const supervisor = new ConnectionSupervisor({
    daemonId: "d1",
    initialBackoffMs: 5,
    maxBackoffMs: 20,
    createBridge: (hooks, token) => {
      const bridge = new FakeBridge(hooks, token);
      bridges.push(bridge);
      return bridge;
    },
    ...options,
  });
  return { supervisor, bridges };
}

const supervisors: ConnectionSupervisor[] = [];
function track(supervisor: ConnectionSupervisor): ConnectionSupervisor {
  supervisors.push(supervisor);
  return supervisor;
}
afterEach(() => {
  for (const s of supervisors.splice(0)) s.close();
});

const ASK: ReviewAskStreamEvent = { kind: "ask-focus", anchor: "a" } as ReviewAskStreamEvent;

describe("ConnectionSupervisor — reachability", () => {
  it("starts connecting and reaches online on the handshake, notifying subscribers", async () => {
    const { supervisor, bridges } = makeSupervisor();
    track(supervisor);
    const seen: string[] = [];
    supervisor.subscribe((s) => seen.push(s.state));
    // The factory resolves the token asynchronously; wait for the first bridge.
    await waitFor(() => bridges.length === 1);
    expect(supervisor.state.state).toBe("connecting");
    nth(bridges, 0).goOnline();
    expect(supervisor.state.state).toBe("online");
    expect(seen).toEqual(["connecting", "online"]); // immediate current + the online transition
  });

  it("reflects a dropped socket as offline, then online again after reconnect", async () => {
    const { supervisor, bridges } = makeSupervisor();
    track(supervisor);
    await waitFor(() => bridges.length === 1);
    nth(bridges, 0).goOnline();
    nth(bridges, 0).goOffline();
    expect(supervisor.state.state).toBe("offline");
    // Backoff (5ms) makes a fresh bridge; the old one is closed.
    await waitFor(() => bridges.length === 2);
    expect(nth(bridges, 0).closed).toBe(true);
    nth(bridges, 1).goOnline();
    expect(supervisor.state.state).toBe("online");
  });

  it("treats a rejected handshake as terminal error, not a retry", async () => {
    const { supervisor, bridges } = makeSupervisor();
    track(supervisor);
    await waitFor(() => bridges.length === 1);
    nth(bridges, 0).goError("local protocol version 1 is below the remote minimum");
    expect(supervisor.state.state).toBe("error");
    expect(supervisor.state.error).toContain("below the remote minimum");
    // No reconnect scheduled: still one bridge after a backoff window.
    await new Promise((r) => setTimeout(r, 30));
    expect(bridges.length).toBe(1);
    await expect(supervisor.invoke("app.bootstrap" as never, {} as never)).rejects.toBeInstanceOf(
      ConnectionError,
    );
  });
});

describe("ConnectionSupervisor — resubscribe registry (#389 client half)", () => {
  it("re-delivers events to the same listener after a reconnect, with no re-subscribe", async () => {
    const { supervisor, bridges } = makeSupervisor();
    track(supervisor);
    await waitFor(() => bridges.length === 1);
    nth(bridges, 0).goOnline();

    const received: ReviewAskStreamEvent[] = [];
    supervisor.onAskStream("rev-1", (e) => received.push(e)); // ONE consumer subscribe, ever
    nth(bridges, 0).emitAsk("rev-1", ASK);
    expect(received).toHaveLength(1);

    // Socket drops, supervisor reconnects onto a FRESH bridge.
    nth(bridges, 0).goOffline();
    await waitFor(() => bridges.length === 2);
    nth(bridges, 1).goOnline();

    // The fresh bridge has the listener wired by the registry — the consumer never re-subscribed.
    expect(nth(bridges, 1).askListeners.get("rev-1")?.size).toBe(1);
    nth(bridges, 1).emitAsk("rev-1", ASK);
    expect(received).toHaveLength(2); // delivered again, at most once per emit
  });

  it("re-issues review.reattach for subscribed reviews on reconnect (state reconcile)", async () => {
    const { supervisor, bridges } = makeSupervisor();
    track(supervisor);
    await waitFor(() => bridges.length === 1);
    nth(bridges, 0).goOnline();
    supervisor.onAskStream("rev-1", () => undefined);
    nth(bridges, 0).goOffline();
    await waitFor(() => bridges.length === 2);
    nth(bridges, 1).goOnline();
    const reattaches = nth(bridges, 1).invokes.filter((i) => i.name === "review.reattach");
    expect(reattaches).toHaveLength(1);
    expect(nth(reattaches, 0).input).toMatchObject({ reviewId: "rev-1" });
  });

  it("stops delivery after the consumer unsubscribes", async () => {
    const { supervisor, bridges } = makeSupervisor();
    track(supervisor);
    await waitFor(() => bridges.length === 1);
    nth(bridges, 0).goOnline();
    const received: ReviewAskStreamEvent[] = [];
    const off = supervisor.onAskStream("rev-1", (e) => received.push(e));
    off();
    expect(nth(bridges, 0).askListeners.get("rev-1")?.size ?? 0).toBe(0);
    nth(bridges, 0).emitAsk("rev-1", ASK);
    expect(received).toHaveLength(0);
  });
});

describe("ConnectionSupervisor — invoke honesty", () => {
  it("rejects an invoke issued while offline with a ConnectionError (reject mode)", async () => {
    const { supervisor, bridges } = makeSupervisor();
    track(supervisor);
    await waitFor(() => bridges.length === 1); // still connecting, not online
    await expect(supervisor.invoke("app.bootstrap" as never, {} as never)).rejects.toBeInstanceOf(
      ConnectionError,
    );
  });

  it("queues an invoke and flushes it on online (queue mode)", async () => {
    const { supervisor, bridges } = makeSupervisor({ offlineInvoke: "queue" });
    track(supervisor);
    await waitFor(() => bridges.length === 1);
    nth(bridges, 0).invokeImpl = () => Promise.resolve({ ok: true });
    const pending = supervisor.invoke("app.bootstrap" as never, {} as never);
    expect(nth(bridges, 0).invokes).toHaveLength(0); // held, not sent
    nth(bridges, 0).goOnline();
    await expect(pending).resolves.toEqual({ ok: true });
    expect(nth(bridges, 0).invokes).toHaveLength(1);
  });
});

describe("ConnectionSupervisor — stores + presence", () => {
  it("reads the device token from the injected store for each connect", async () => {
    const tokenStore = {
      get: vi.fn(() => "tok-123"),
      set: vi.fn(),
      delete: vi.fn(),
    };
    const { supervisor, bridges } = makeSupervisor({ tokenStore });
    track(supervisor);
    await waitFor(() => bridges.length === 1);
    expect(tokenStore.get).toHaveBeenCalledWith("d1");
    expect(nth(bridges, 0).token).toBe("tok-123");
  });

  it("loads the replica before connect and exposes its staleness; saveReplica persists", async () => {
    const stored: StoredReplica = { surface: { reviews: [] }, savedAt: 1000 };
    const replicaStore = { load: vi.fn(() => stored), save: vi.fn() };
    const { supervisor } = makeSupervisor({ replicaStore });
    track(supervisor);
    await waitFor(() => supervisor.replica !== undefined);
    expect(supervisor.replica).toEqual(stored);
    supervisor.saveReplica({ reviews: [{ id: "r1" }] });
    expect(replicaStore.save).toHaveBeenCalledWith("d1", { reviews: [{ id: "r1" }] });
    expect(supervisor.replica?.surface).toEqual({ reviews: [{ id: "r1" }] });
    expect(supervisor.replica?.savedAt).toBeGreaterThan(0);
  });

  it("records presence without any wire traffic", async () => {
    const { supervisor, bridges } = makeSupervisor();
    track(supervisor);
    await waitFor(() => bridges.length === 1);
    nth(bridges, 0).goOnline();
    supervisor.setPresence({ focused: false, visible: false, deviceClass: "mobile" });
    expect(supervisor.presence).toEqual({ focused: false, visible: false, deviceClass: "mobile" });
    expect(nth(bridges, 0).invokes).toHaveLength(0); // wire-silent
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The #389 positive control over a REAL socket: the supervisor drives a real
// WsRennetBridge against a `ws` stub server that resumes streaming to whichever socket
// is currently connected. A live ask-stream started before a mid-turn drop keeps
// delivering to the same consumer after the reconnect — the property the resubscribe
// registry exists to guarantee. (Disable `#wireRegistry`'s replay and this goes red:
// the fresh bridge would carry no listeners.)
// ─────────────────────────────────────────────────────────────────────────────
describe("ConnectionSupervisor — reconnect-resubscribe over a real socket (#389)", () => {
  const servers: Array<{ server: WebSocketServer; sockets: Set<NodeWebSocket> }> = [];
  afterEach(async () => {
    // Close the supervisors FIRST so no client is mid-reconnect, then force-terminate any
    // straggler socket before closing the server — otherwise `server.close` waits forever.
    for (const s of supervisors.splice(0)) s.close();
    for (const { server, sockets } of servers.splice(0)) {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  function startStub(): Promise<{
    url: string;
    broadcast: (f: unknown) => void;
    drop: () => void;
    helloCount: () => number;
  }> {
    return new Promise((resolve) => {
      const sockets = new Set<NodeWebSocket>();
      let helloCount = 0;
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }, () => {
        resolve({
          url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
          broadcast: (frame) => {
            const payload = JSON.stringify(frame);
            for (const s of sockets) s.send(payload);
          },
          drop: () => {
            for (const s of sockets) s.close();
          },
          helloCount: () => helloCount,
        });
      });
      servers.push({ server, sockets });
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("message", (data) => {
          const frame = JSON.parse(data.toString());
          if (frame.type === "hello") {
            helloCount += 1;
            socket.send(
              JSON.stringify({
                type: "serverInfo",
                version: "stub",
                protocolVersion: 1,
                minCompatibleProtocolVersion: 1,
                features: {},
              }),
            );
          }
        });
      });
    });
  }

  it("resumes a live ask stream to the same consumer after a mid-turn reconnect", async () => {
    const stub = await startStub();
    const supervisor = track(
      new ConnectionSupervisor({
        daemonId: "d1",
        initialBackoffMs: 10,
        createBridge: (hooks, token) =>
          new WsRennetBridge({
            url: stub.url,
            deviceToken: token,
            autoReconnect: false,
            onLifecycle: hooks.onLifecycle,
          }),
      }),
    );

    await waitFor(() => supervisor.state.state === "online");
    const received: ReviewAskStreamEvent[] = [];
    supervisor.onAskStream("rev-1", (e) => received.push(e));

    stub.broadcast({ type: "askStreamEvent", reviewId: "rev-1", event: ASK });
    await waitFor(() => received.length === 1);

    // Mid-turn: drop every socket. The supervisor reconnects onto a fresh bridge.
    stub.drop();
    await waitFor(() => supervisor.state.state === "offline");
    await waitFor(() => supervisor.state.state === "online", 2000);
    expect(stub.helloCount()).toBe(2);

    // The turn continues: a subsequent delta lands on the SAME consumer, no re-subscribe.
    stub.broadcast({ type: "askStreamEvent", reviewId: "rev-1", event: ASK });
    await waitFor(() => received.length === 2, 2000);
    expect(received).toHaveLength(2);
  });
});

/** Index an array with a throw instead of `undefined` (noUncheckedIndexedAccess). */
function nth<T>(arr: readonly T[], i: number): T {
  const value = arr[i];
  if (value === undefined) throw new Error(`expected element ${i}`);
  return value;
}

/** Poll until `predicate` holds or the timeout elapses (default 1s). */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
