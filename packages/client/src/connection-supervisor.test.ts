import type { AddressInfo } from "node:net";
import type {
  AskProjection,
  AttentionEventFrame,
  LensDraftEvent,
  ProjectDetailProgressEvent,
  ProjectProcessEvent,
  RoundEvent,
} from "@rennet/protocol";
import { MIN_COMPATIBLE_PROTOCOL_VERSION, PROTOCOL_VERSION } from "@rennet/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import {
  type BridgeHooks,
  ConnectionError,
  ConnectionSupervisor,
  type SupervisedBridge,
} from "./connection-supervisor";
import type { StoredReplica } from "./stores";
import type { CapturedServerInfo } from "./ws-bridge";
import { WsRennetBridge } from "./ws-bridge";

// ─────────────────────────────────────────────────────────────────────────────
// A scriptable in-memory bridge so the state machine, registry, stores, and presence
// are pinned deterministically (no sockets). The factory records every bridge it makes,
// so a test drives the LATEST one — that is the whole point of the swap tests.
// ─────────────────────────────────────────────────────────────────────────────
class FakeBridge implements SupervisedBridge {
  serverInfo: CapturedServerInfo | null = null;
  closed = false;
  readonly invokes: Array<{ name: string; input: unknown }> = [];
  readonly sentPresence: Array<Record<string, unknown>> = [];
  readonly askProjectionListeners = new Map<string, Set<(e: AskProjection) => void>>();
  readonly progressListeners = new Map<string, Set<(e: ProjectProcessEvent) => void>>();
  readonly attentionListeners = new Set<(e: AttentionEventFrame) => void>();
  invokeImpl: (name: string, input: unknown) => Promise<unknown> = () => Promise.resolve({});

  constructor(
    readonly hooks: BridgeHooks,
    readonly token: string | undefined,
  ) {}

  sendPresence(presence: {
    focused: boolean;
    visible: boolean;
    deviceClass: string;
    focusedReviewId?: string;
  }): void {
    this.sentPresence.push({ ...presence });
  }

  invoke(name: string, input: unknown): Promise<never> {
    this.invokes.push({ name, input });
    return this.invokeImpl(name, input) as Promise<never>;
  }
  onAskProjection(reviewId: string, listener: (e: AskProjection) => void): () => void {
    return add(this.askProjectionListeners, reviewId, listener);
  }
  readonly roundListeners = new Map<string, Set<(e: RoundEvent) => void>>();
  onRoundProgress(reviewId: string, listener: (e: RoundEvent) => void): () => void {
    return add(this.roundListeners, reviewId, listener);
  }
  emitRound(reviewId: string, event: RoundEvent): void {
    for (const l of this.roundListeners.get(reviewId) ?? []) l(event);
  }
  readonly lensDraftListeners = new Map<string, Set<(e: LensDraftEvent) => void>>();
  onLensDraft(reviewId: string, listener: (e: LensDraftEvent) => void): () => void {
    return add(this.lensDraftListeners, reviewId, listener);
  }
  emitLensDraft(reviewId: string, event: LensDraftEvent): void {
    for (const l of this.lensDraftListeners.get(reviewId) ?? []) l(event);
  }
  onProgress(commandId: string, listener: (e: ProjectProcessEvent) => void): () => void {
    return add(this.progressListeners, commandId, listener);
  }
  readonly detailProgressListeners = new Map<
    string,
    Set<(e: ProjectDetailProgressEvent) => void>
  >();
  onProjectDetailProgress(
    commandId: string,
    listener: (e: ProjectDetailProgressEvent) => void,
  ): () => void {
    return add(this.detailProgressListeners, commandId, listener);
  }
  onAttention(listener: (e: AttentionEventFrame) => void): () => void {
    this.attentionListeners.add(listener);
    return () => void this.attentionListeners.delete(listener);
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
  emitAskProjection(reviewId: string, projection: AskProjection): void {
    for (const listener of this.askProjectionListeners.get(reviewId) ?? []) listener(projection);
  }
  emitAttention(event: AttentionEventFrame): void {
    for (const l of this.attentionListeners) l(event);
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

const ASK: AskProjection = {
  stagedAsks: {},
  lineComments: {},
  findings: {},
  findingDispositions: {},
  quoteThreads: {},
  retired: {},
  verdictOverride: null,
} as unknown as AskProjection;

/** One accepted board write, as the daemon publishes it (`lens-board-tools` D11). */
const DRAFT_FRAME: LensDraftEvent = {
  generation: "gen:ps-1",
  lens: "sequence",
  revision: 1,
  update: { kind: "state", state: "drafting" },
};

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

  it("stamps `since` on the offline transition — the shell banner's elapsed-time anchor", async () => {
    const { supervisor, bridges } = makeSupervisor();
    track(supervisor);
    await waitFor(() => bridges.length === 1);
    nth(bridges, 0).goOnline();
    const before = Date.now();
    nth(bridges, 0).goOffline();
    expect(supervisor.state.state).toBe("offline");
    expect(supervisor.state.since).toBeGreaterThanOrEqual(before);
    expect(supervisor.state.since).toBeLessThanOrEqual(Date.now());
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
  it("re-subscribes to ask projections and reconciles changes missed while offline", async () => {
    const { supervisor, bridges } = makeSupervisor();
    track(supervisor);
    await waitFor(() => bridges.length === 1);
    nth(bridges, 0).goOnline();

    const received: AskProjection[] = [];
    supervisor.onAskProjection("rev-1", (projection) => received.push(projection));
    const projection: AskProjection = {
      stagedAsks: {},
      findingDispositions: {},
      lineComments: {},
      quoteThreads: {},
      retired: {},
      verdictOverride: null,
    };
    nth(bridges, 0).emitAskProjection("rev-1", projection);
    expect(received).toEqual([projection]);

    nth(bridges, 0).goOffline();
    await waitFor(() => bridges.length === 2);
    nth(bridges, 1).invokeImpl = (name) =>
      Promise.resolve(name === "ask.read" ? { projection } : {});
    nth(bridges, 1).goOnline();

    await waitFor(() => received.length === 2);
    expect(nth(bridges, 1).askProjectionListeners.get("rev-1")?.size).toBe(1);
    expect(nth(bridges, 1).invokes).toContainEqual({
      name: "ask.read",
      input: { sessionId: "rev-1" },
    });
  });

  it("does not let an older reconnect read overwrite a newer projection push", async () => {
    const { supervisor, bridges } = makeSupervisor();
    track(supervisor);
    await waitFor(() => bridges.length === 1);
    nth(bridges, 0).goOnline();

    const received: AskProjection[] = [];
    supervisor.onAskProjection("rev-1", (projection) => received.push(projection));
    nth(bridges, 0).goOffline();
    await waitFor(() => bridges.length === 2);

    let resolveRead!: (value: { projection: AskProjection }) => void;
    nth(bridges, 1).invokeImpl = () =>
      new Promise((resolve) => {
        resolveRead = resolve as (value: { projection: AskProjection }) => void;
      });
    nth(bridges, 1).goOnline();
    await waitFor(() => nth(bridges, 1).invokes.some((call) => call.name === "ask.read"));

    const current: AskProjection = {
      stagedAsks: {},
      findingDispositions: {},
      lineComments: {},
      quoteThreads: {},
      retired: {},
      verdictOverride: null,
    };
    nth(bridges, 1).emitAskProjection("rev-1", current);
    resolveRead({
      projection: {
        ...current,
        stagedAsks: {
          consumed: {
            id: "consumed",
            anchor: "src/a.ts:1",
            type: "request-change",
            body: "stale",
          },
        },
      },
    });
    await Promise.resolve();

    expect(received).toEqual([current]);
  });

  it("re-delivers events to the same listener after a reconnect, with no re-subscribe", async () => {
    const { supervisor, bridges } = makeSupervisor();
    track(supervisor);
    await waitFor(() => bridges.length === 1);
    nth(bridges, 0).goOnline();

    const received: AskProjection[] = [];
    supervisor.onAskProjection("rev-1", (e) => received.push(e)); // ONE consumer subscribe, ever
    nth(bridges, 0).emitAskProjection("rev-1", ASK);
    expect(received).toHaveLength(1);

    // Socket drops, supervisor reconnects onto a FRESH bridge.
    nth(bridges, 0).goOffline();
    await waitFor(() => bridges.length === 2);
    nth(bridges, 1).goOnline();

    // The fresh bridge has the listener wired by the registry — the consumer never re-subscribed.
    expect(nth(bridges, 1).askProjectionListeners.get("rev-1")?.size).toBe(1);
    nth(bridges, 1).emitAskProjection("rev-1", ASK);
    expect(received).toHaveLength(2); // delivered again, at most once per emit
  });

  it("re-delivers lens-draft frames to the same listener after a reconnect", async () => {
    // `lens-board-tools` D11, and the LAST link of a seam this wave exists to close.
    // `onLensDraft` shipped in wave 4 with no caller; this wave supplied one, and every
    // link between the socket and the screen has a control except this one — the registry
    // re-attach, which is silent when it breaks because nothing re-subscribes to notice.
    //
    // A board is written over minutes, so a socket that drops mid-generation is the
    // ordinary case rather than the exotic one: without the re-attach, the reviewer's
    // board simply stops filling and nothing anywhere says why. Missed frames are not
    // replayed by design — `board.draft`'s `revision` is what closes that gap — so this
    // proves the CHANNEL resumes, which is the part the registry owns.
    const { supervisor, bridges } = makeSupervisor();
    track(supervisor);
    await waitFor(() => bridges.length === 1);
    nth(bridges, 0).goOnline();

    const received: LensDraftEvent[] = [];
    supervisor.onLensDraft("rev-1", (e) => received.push(e)); // ONE consumer subscribe, ever
    nth(bridges, 0).emitLensDraft("rev-1", DRAFT_FRAME);
    expect(received).toHaveLength(1);

    // Socket drops mid-draft; the supervisor reconnects onto a FRESH bridge.
    nth(bridges, 0).goOffline();
    await waitFor(() => bridges.length === 2);
    nth(bridges, 1).goOnline();

    // The fresh bridge carries the listener, wired by the registry rather than by the
    // consumer — which never re-subscribed and has no way to know it should.
    expect(nth(bridges, 1).lensDraftListeners.get("rev-1")?.size).toBe(1);
    nth(bridges, 1).emitLensDraft("rev-1", DRAFT_FRAME);
    expect(received).toHaveLength(2); // delivered again, at most once per emit

    // KEYED, not broadcast: another review's frames never reach this listener. Without
    // this the assertion above would pass over a registry that re-attached everything to
    // everyone, which is a different bug wearing the same green bar.
    nth(bridges, 1).emitLensDraft("rev-2", DRAFT_FRAME);
    expect(received).toHaveLength(2);
  });

  it("re-delivers attention events to the same listener after a reconnect (#383 batch)", async () => {
    const { supervisor, bridges } = makeSupervisor();
    track(supervisor);
    await waitFor(() => bridges.length === 1);
    nth(bridges, 0).goOnline();

    const seen: AttentionEventFrame[] = [];
    supervisor.onAttention((e) => seen.push(e)); // ONE subscribe, ever
    const raised: AttentionEventFrame = {
      type: "attentionEvent",
      event: "raised",
      item: {
        id: "ask-pending:rev-1",
        family: "ask-pending",
        reviewId: "rev-1",
        deepLink: "rennet://review/rev-1/ask",
        title: "Ask pending",
        body: "",
      },
    };
    nth(bridges, 0).emitAttention(raised);
    expect(seen).toHaveLength(1);

    // Reconnect onto a fresh bridge — the registry re-wires the listener (survives reconnect).
    nth(bridges, 0).goOffline();
    await waitFor(() => bridges.length === 2);
    nth(bridges, 1).goOnline();
    expect(nth(bridges, 1).attentionListeners.size).toBe(1);
    nth(bridges, 1).emitAttention({
      type: "attentionEvent",
      event: "cleared",
      clearedIds: ["ask-pending:rev-1"],
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ event: "cleared" });
  });

  it("re-reads ask.read for subscribed reviews on reconnect (state reconcile)", async () => {
    const { supervisor, bridges } = makeSupervisor();
    track(supervisor);
    await waitFor(() => bridges.length === 1);
    nth(bridges, 0).goOnline();
    supervisor.onAskProjection("rev-1", () => undefined);
    nth(bridges, 0).goOffline();
    await waitFor(() => bridges.length === 2);
    nth(bridges, 1).goOnline();
    // `review.reattach` went with the orchestrator chat (t3-lens-threads 4.2); the durable
    // ask projection is what a reconnect now has to re-read, and it is the same registry.
    const rereads = nth(bridges, 1).invokes.filter((i) => i.name === "ask.read");
    expect(rereads).toHaveLength(1);
    expect(nth(rereads, 0).input).toMatchObject({ sessionId: "rev-1" });
  });

  it("stops delivery after the consumer unsubscribes", async () => {
    const { supervisor, bridges } = makeSupervisor();
    track(supervisor);
    await waitFor(() => bridges.length === 1);
    nth(bridges, 0).goOnline();
    const received: AskProjection[] = [];
    const off = supervisor.onAskProjection("rev-1", (e) => received.push(e));
    off();
    expect(nth(bridges, 0).askProjectionListeners.get("rev-1")?.size ?? 0).toBe(0);
    nth(bridges, 0).emitAskProjection("rev-1", ASK);
    expect(received).toHaveLength(0);
  });

  it("keeps a shared callback's other subscription live when one is unsubscribed", async () => {
    // ONE callback on TWO reviews: unsubscribing it from rev-A must not detach rev-B. Regresses
    // the disposer-keyed-by-listener-alone bug (rev-A's disposer overwrote rev-B's).
    const { supervisor, bridges } = makeSupervisor();
    track(supervisor);
    await waitFor(() => bridges.length === 1);
    nth(bridges, 0).goOnline();
    const received: string[] = [];
    const shared = (): void => {
      received.push("delivered");
    };
    const offA = supervisor.onAskProjection("rev-A", shared);
    supervisor.onAskProjection("rev-B", shared);
    offA(); // detach rev-A only
    expect(nth(bridges, 0).askProjectionListeners.get("rev-A")?.size ?? 0).toBe(0);
    expect(nth(bridges, 0).askProjectionListeners.get("rev-B")?.size ?? 0).toBe(1); // rev-B still live
    nth(bridges, 0).emitAskProjection("rev-B", ASK);
    expect(received).toEqual(["delivered"]);
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

  it("rejects a queued invoke past the cap instead of growing unbounded (queue mode)", async () => {
    const { supervisor, bridges } = makeSupervisor({ offlineInvoke: "queue", maxQueuedInvokes: 2 });
    track(supervisor);
    await waitFor(() => bridges.length === 1); // still connecting — everything queues
    const held = [
      supervisor.invoke("app.bootstrap" as never, {} as never),
      supervisor.invoke("app.bootstrap" as never, {} as never),
    ];
    // The third exceeds the cap: rejected now, never enqueued.
    await expect(supervisor.invoke("app.bootstrap" as never, {} as never)).rejects.toBeInstanceOf(
      ConnectionError,
    );
    nth(bridges, 0).invokeImpl = () => Promise.resolve({ ok: true });
    nth(bridges, 0).goOnline();
    await expect(Promise.all(held)).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(nth(bridges, 0).invokes).toHaveLength(2); // only the two under the cap flushed
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
                protocolVersion: PROTOCOL_VERSION,
                minCompatibleProtocolVersion: MIN_COMPATIBLE_PROTOCOL_VERSION,
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
    const received: AskProjection[] = [];
    supervisor.onAskProjection("rev-1", (e) => received.push(e));

    stub.broadcast({ type: "askProjection", sessionId: "rev-1", projection: ASK });
    await waitFor(() => received.length === 1);

    // Mid-turn: drop every socket. The supervisor reconnects onto a fresh bridge.
    stub.drop();
    await waitFor(() => supervisor.state.state === "offline");
    await waitFor(() => supervisor.state.state === "online", 2000);
    expect(stub.helloCount()).toBe(2);

    // The turn continues: a subsequent delta lands on the SAME consumer, no re-subscribe.
    stub.broadcast({ type: "askProjection", sessionId: "rev-1", projection: ASK });
    await waitFor(() => received.length === 2, 2000);
    expect(received).toHaveLength(2);
  });
});

const ATTENTION_INFO: CapturedServerInfo = { version: "1.0.0", features: { attention: true } };
const NO_ATTENTION_INFO: CapturedServerInfo = {
  version: "1.0.0",
  features: { serverRequests: true },
};

describe("ConnectionSupervisor — presence transmission (client-runtime delta spec, #383 M1)", () => {
  it("transmits presence when the daemon advertised attention, and re-sends on reconnect", async () => {
    const { supervisor, bridges } = makeSupervisor();
    track(supervisor);
    await waitFor(() => bridges.length === 1);
    nth(bridges, 0).serverInfo = ATTENTION_INFO;
    nth(bridges, 0).goOnline();
    // Going online re-sends current presence once (the default), before any shell update.
    expect(nth(bridges, 0).sentPresence).toHaveLength(1);

    supervisor.setPresence({
      focused: true,
      visible: true,
      deviceClass: "phone",
      focusedReviewId: "rev-1",
    });
    expect(nth(bridges, 0).sentPresence).toHaveLength(2);
    expect(nth(bridges, 0).sentPresence[1]).toMatchObject({
      focusedReviewId: "rev-1",
      deviceClass: "phone",
    });

    // A reconnect makes a fresh bridge; presence must re-send to it on `online` with no shell action.
    nth(bridges, 0).goOffline();
    await waitFor(() => bridges.length === 2);
    nth(bridges, 1).serverInfo = ATTENTION_INFO;
    nth(bridges, 1).goOnline();
    expect(nth(bridges, 1).sentPresence).toHaveLength(1);
    expect(nth(bridges, 1).sentPresence[0]).toMatchObject({ focusedReviewId: "rev-1" });
  });

  it("stays wire-silent against a daemon that did not advertise attention (M0-era daemon)", async () => {
    const { supervisor, bridges } = makeSupervisor();
    track(supervisor);
    await waitFor(() => bridges.length === 1);
    nth(bridges, 0).serverInfo = NO_ATTENTION_INFO;
    nth(bridges, 0).goOnline();

    supervisor.setPresence({ focused: false, visible: false, deviceClass: "phone" });
    // Recorded locally, nothing on the wire.
    expect(supervisor.presence).toMatchObject({ focused: false, visible: false });
    expect(nth(bridges, 0).sentPresence).toHaveLength(0);
  });

  it("reads the daemon's `act` capability so a client can render acting affordances truthfully (#382 M2)", async () => {
    const { supervisor, bridges } = makeSupervisor();
    track(supervisor);
    await waitFor(() => bridges.length === 1);
    // Pre-M2 daemon (no `act`): the phone would show Stop disabled / publish needs-updating.
    nth(bridges, 0).serverInfo = { version: "1.0.0", features: { attention: true } };
    nth(bridges, 0).goOnline();
    expect(supervisor.actAdvertised()).toBe(false);
    // M2 daemon advertises it.
    nth(bridges, 0).serverInfo = { version: "1.0.0", features: { attention: true, act: true } };
    expect(supervisor.actAdvertised()).toBe(true);
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
