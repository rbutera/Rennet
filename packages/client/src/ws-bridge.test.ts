import type { AddressInfo } from "node:net";
import { MIN_COMPATIBLE_PROTOCOL_VERSION, PROTOCOL_VERSION } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import { WsRennetBridge } from "./ws-bridge";

// The bridge speaks the real session envelope; these tests drive it against a `ws`
// stub server that we script frame-by-frame, pinning the transport behaviour
// (correlation, error surfacing, push routing, unsubscribe, reconnect) without the
// real dispatch. The end-to-end path through the real listener is the server-side
// contract test (packages/server/ws-contract.test.ts).

interface Stub {
  url: string;
  helloCount: number;
  /** Set to script how each `request` frame is answered. */
  onRequest: ((socket: NodeWebSocket, frame: RequestFrameShape) => void) | null;
  /** Send a raw frame to every connected socket (progress/ask-stream fan-out). */
  broadcast: (frame: unknown) => void;
  /** Drop every live socket without closing the server (simulates a server hiccup). */
  dropConnections: () => void;
  close: () => Promise<void>;
}

interface RequestFrameShape {
  readonly type: "request";
  readonly requestId: string;
  readonly command: string;
  readonly input: unknown;
}

interface HelloFrameShape {
  readonly type: "hello";
  readonly clientId: string;
}

function startStub(
  onHello?: (socket: NodeWebSocket, frame: HelloFrameShape) => void,
): Promise<Stub> {
  return new Promise((resolve) => {
    const sockets = new Set<NodeWebSocket>();
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }, () => {
      stub.url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve(stub);
    });
    const stub: Stub = {
      url: "",
      helloCount: 0,
      onRequest: null,
      broadcast: (frame) => {
        const payload = JSON.stringify(frame);
        for (const socket of sockets) socket.send(payload);
      },
      dropConnections: () => {
        for (const socket of sockets) socket.close();
      },
      close: () =>
        new Promise<void>((done) => {
          for (const socket of sockets) socket.terminate();
          server.close(() => done());
        }),
    };
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString());
        if (frame.type === "hello") {
          stub.helloCount += 1;
          if (onHello) {
            onHello(socket, frame as HelloFrameShape);
            return;
          }
          socket.send(
            JSON.stringify({
              type: "serverInfo",
              version: "stub",
              protocolVersion: PROTOCOL_VERSION,
              minCompatibleProtocolVersion: MIN_COMPATIBLE_PROTOCOL_VERSION,
              features: {},
            }),
          );
          return;
        }
        if (frame.type === "request") stub.onRequest?.(socket, frame as RequestFrameShape);
      });
    });
  });
}

// Loosely-typed invoke: the transport correlates by requestId and never inspects the
// command name or input, so these tests use arbitrary strings rather than coupling to
// real command schemas.
function invoke(bridge: WsRennetBridge, name: string, input: unknown): Promise<unknown> {
  return (bridge.invoke as unknown as (n: string, i: unknown) => Promise<unknown>)(name, input);
}

const bridges: WsRennetBridge[] = [];
const stubs: Stub[] = [];
function trackBridge(bridge: WsRennetBridge): WsRennetBridge {
  bridges.push(bridge);
  return bridge;
}

afterEach(async () => {
  for (const bridge of bridges.splice(0)) bridge.close();
  for (const stub of stubs.splice(0)) await stub.close();
});

describe("WsRennetBridge", () => {
  it("correlates interleaved invokes to their own outputs regardless of response order", async () => {
    const stub = await startStub();
    stubs.push(stub);
    // Hold both requests, then answer them in REVERSE arrival order.
    const held: RequestFrameShape[] = [];
    stub.onRequest = (socket, frame) => {
      held.push(frame);
      if (held.length === 2) {
        for (const request of [...held].reverse()) {
          socket.send(
            JSON.stringify({
              type: "response",
              requestId: request.requestId,
              output: request.input,
            }),
          );
        }
      }
    };
    const bridge = trackBridge(new WsRennetBridge({ url: stub.url }));
    const [a, b] = await Promise.all([
      invoke(bridge, "cmd.a", { tag: "A" }),
      invoke(bridge, "cmd.b", { tag: "B" }),
    ]);
    expect(a).toEqual({ tag: "A" });
    expect(b).toEqual({ tag: "B" });
  });

  it("rejects an invoke with the rpcError message as an Error", async () => {
    const stub = await startStub();
    stubs.push(stub);
    stub.onRequest = (socket, frame) => {
      socket.send(
        JSON.stringify({
          type: "rpcError",
          requestId: frame.requestId,
          code: "command_failed",
          message: "boom from the command",
        }),
      );
    };
    const bridge = trackBridge(new WsRennetBridge({ url: stub.url }));
    await expect(invoke(bridge, "cmd.fail", {})).rejects.toThrow("boom from the command");
  });

  it("rejects an invoke when serverInfo reports an incompatible protocol window", async () => {
    const stub = await startStub((socket) => {
      socket.send(
        JSON.stringify({
          type: "serverInfo",
          version: "stub",
          protocolVersion: PROTOCOL_VERSION + 1,
          minCompatibleProtocolVersion: PROTOCOL_VERSION + 1,
          features: {},
        }),
      );
    });
    stubs.push(stub);
    const bridge = trackBridge(new WsRennetBridge({ url: stub.url, initialBackoffMs: 10 }));

    await expect(invoke(bridge, "cmd.incompatible", {})).rejects.toThrow(
      `local protocol version ${PROTOCOL_VERSION} is below the remote minimum compatible version ${PROTOCOL_VERSION + 1}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stub.helloCount).toBe(1);
  });

  it("surfaces an incompatible_protocol rpcError correlated to hello", async () => {
    const stub = await startStub((socket, frame) => {
      socket.send(
        JSON.stringify({
          type: "rpcError",
          requestId: frame.clientId,
          code: "incompatible_protocol",
          message: "server rejected the client protocol",
        }),
      );
    });
    stubs.push(stub);
    const bridge = trackBridge(new WsRennetBridge({ url: stub.url, initialBackoffMs: 10 }));

    await expect(invoke(bridge, "cmd.incompatible", {})).rejects.toThrow(
      "server rejected the client protocol",
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stub.helloCount).toBe(1);
  });

  it("treats an `unauthorized` rpcError as a terminal handshake error, not a retry (#383)", async () => {
    // A present-but-rejected device token: the daemon answers hello with `unauthorized` and
    // closes. The bridge must surface `error` (never silently retry the bad token) and stop.
    const stub = await startStub((socket, frame) => {
      socket.send(
        JSON.stringify({
          type: "rpcError",
          requestId: frame.clientId,
          code: "unauthorized",
          message: "device token rejected",
        }),
      );
    });
    stubs.push(stub);
    const lifecycle: string[] = [];
    const bridge = trackBridge(
      new WsRennetBridge({
        url: stub.url,
        deviceToken: "revoked",
        initialBackoffMs: 10,
        onLifecycle: (event) => lifecycle.push(event.kind),
      }),
    );

    await expect(invoke(bridge, "cmd.after-reject", {})).rejects.toThrow("device token rejected");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(lifecycle).toContain("error");
    expect(lifecycle).not.toContain("online");
    expect(stub.helloCount).toBe(1); // terminal: no reconnect against the rejected token
  });

  it("routes progress, ask-stream, and ask-projection frames to their keyed listeners", async () => {
    const stub = await startStub();
    stubs.push(stub);
    const bridge = trackBridge(new WsRennetBridge({ url: stub.url }));
    // Wait for the handshake so the socket is open before we broadcast.
    await new Promise<void>((resolve) => {
      const check = () => (stub.helloCount > 0 ? resolve() : setTimeout(check, 5));
      check();
    });
    const progress: unknown[] = [];
    const asks: unknown[] = [];
    const projections: unknown[] = [];
    bridge.onProgress("cmd-1", (event) => progress.push(event));
    bridge.onAskStream("rev-1", (event) => asks.push(event));
    bridge.onAskProjection("rev-1", (projection) => projections.push(projection));

    stub.broadcast({
      type: "progressEvent",
      commandId: "cmd-1",
      event: { kind: "repo-error", repo: "r", message: "m" },
    });
    stub.broadcast({
      type: "progressEvent",
      commandId: "other",
      event: { kind: "repo-error", repo: "r", message: "not for us" },
    });
    stub.broadcast({
      type: "askStreamEvent",
      reviewId: "rev-1",
      event: { kind: "ask-focus", anchor: "a" },
    });
    stub.broadcast({
      type: "askProjection",
      sessionId: "rev-1",
      projection: {
        stagedAsks: {},
        findingDispositions: {},
        lineComments: {},
        quoteThreads: {},
        retired: {},
        verdictOverride: null,
      },
    });
    stub.broadcast({
      type: "askProjection",
      sessionId: "other",
      projection: {
        stagedAsks: {},
        findingDispositions: {},
        lineComments: {},
        quoteThreads: {},
        retired: {},
        verdictOverride: null,
      },
    });
    await waitFor(() => progress.length === 1 && asks.length === 1 && projections.length === 1);
    expect(progress).toEqual([{ kind: "repo-error", repo: "r", message: "m" }]);
    expect(asks).toEqual([{ kind: "ask-focus", anchor: "a" }]);
    expect(projections).toHaveLength(1);
  });

  it("fans attentionEvent frames out to onAttention listeners (#383 batch)", async () => {
    const stub = await startStub();
    stubs.push(stub);
    const bridge = trackBridge(new WsRennetBridge({ url: stub.url }));
    await waitFor(() => stub.helloCount > 0);
    const seen: Array<{ event: string }> = [];
    const off = bridge.onAttention((frame) => seen.push({ event: frame.event }));

    stub.broadcast({
      type: "attentionEvent",
      event: "raised",
      item: {
        id: "review-finished:rev-1",
        family: "review-finished",
        reviewId: "rev-1",
        deepLink: "rennet://review/rev-1/digest",
        title: "Review finished",
        body: "",
      },
    });
    stub.broadcast({
      type: "attentionEvent",
      event: "cleared",
      clearedIds: ["review-finished:rev-1"],
    });
    await waitFor(() => seen.length === 2);
    expect(seen.map((s) => s.event)).toEqual(["raised", "cleared"]);

    // Unsubscribe stops delivery.
    off();
    stub.broadcast({ type: "attentionEvent", event: "cleared", clearedIds: ["x"] });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen).toHaveLength(2);
  });

  it("stops delivery after unsubscribe", async () => {
    const stub = await startStub();
    stubs.push(stub);
    const bridge = trackBridge(new WsRennetBridge({ url: stub.url }));
    await waitFor(() => stub.helloCount > 0);
    const seen: unknown[] = [];
    const unsubscribe = bridge.onProgress("cmd-1", (event) => seen.push(event));
    stub.broadcast({
      type: "progressEvent",
      commandId: "cmd-1",
      event: { kind: "repo-error", repo: "r", message: "first" },
    });
    await waitFor(() => seen.length === 1);
    unsubscribe();
    stub.broadcast({
      type: "progressEvent",
      commandId: "cmd-1",
      event: { kind: "repo-error", repo: "r", message: "second" },
    });
    // Give the second frame a chance to (wrongly) arrive, then assert it did not.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen).toHaveLength(1);
  });

  it("reconnects and re-sends hello after the connection drops, then invokes succeed", async () => {
    const stub = await startStub();
    stubs.push(stub);
    stub.onRequest = (socket, frame) => {
      socket.send(
        JSON.stringify({ type: "response", requestId: frame.requestId, output: { ok: true } }),
      );
    };
    const bridge = trackBridge(new WsRennetBridge({ url: stub.url, initialBackoffMs: 10 }));
    await waitFor(() => stub.helloCount === 1);
    // Drop the socket; an in-flight invoke rejects fast, then the bridge reconnects.
    const inFlight = invoke(bridge, "cmd.slow", {});
    stub.dropConnections();
    await expect(inFlight).rejects.toThrow();
    await waitFor(() => stub.helloCount === 2, 2000);
    await expect(invoke(bridge, "cmd.after", {})).resolves.toEqual({ ok: true });
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

describe("WsRennetBridge remote surface (#380)", () => {
  const openBridges: WsRennetBridge[] = [];
  const servers: WebSocketServer[] = [];
  afterEach(async () => {
    for (const bridge of openBridges.splice(0)) bridge.close();
    for (const server of servers.splice(0)) await new Promise<void>((r) => server.close(() => r()));
  });

  /** A bespoke server that completes the handshake and hands the test the live socket + captured hello. */
  function startServer(handlers: {
    onHello?: (frame: Record<string, unknown>) => void;
    onSocket?: (socket: NodeWebSocket) => void;
  }): Promise<{ url: string }> {
    return new Promise((resolve) => {
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }, () => {
        resolve({ url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}` });
      });
      servers.push(server);
      server.on("connection", (socket) => {
        handlers.onSocket?.(socket);
        socket.on("message", (data) => {
          const frame = JSON.parse(data.toString());
          if (frame.type === "hello") {
            handlers.onHello?.(frame);
            socket.send(
              JSON.stringify({
                type: "serverInfo",
                version: "stub",
                protocolVersion: PROTOCOL_VERSION,
                minCompatibleProtocolVersion: MIN_COMPATIBLE_PROTOCOL_VERSION,
                features: { serverRequests: true },
              }),
            );
          }
        });
      });
    });
  }

  const waitFor = async (predicate: () => boolean): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("waitFor timed out");
  };

  it("sends the device token in hello and exposes captured serverInfo", async () => {
    let helloFrame: Record<string, unknown> | undefined;
    const { url } = await startServer({
      onHello: (frame) => {
        helloFrame = frame;
      },
    });
    const bridge = new WsRennetBridge({ url, deviceToken: "dev-token-123" });
    openBridges.push(bridge);
    await waitFor(() => bridge.serverInfo !== null);
    expect(helloFrame?.deviceToken).toBe("dev-token-123");
    expect(bridge.serverInfo).toEqual({ version: "stub", features: { serverRequests: true } });
  });

  it("answers a serverRequest with a serverResponse", async () => {
    let liveSocket: NodeWebSocket | undefined;
    const answers: unknown[] = [];
    const { url } = await startServer({
      onSocket: (socket) => {
        liveSocket = socket;
        socket.on("message", (data) => {
          const frame = JSON.parse(data.toString());
          if (frame.type === "serverResponse") answers.push(frame.payload);
        });
      },
    });
    const bridge = new WsRennetBridge({ url });
    openBridges.push(bridge);
    bridge.onServerRequest((kind, payload) => ({ echoedKind: kind, echoedPayload: payload }));
    // Wait for the handshake, then ask.
    await waitFor(() => bridge.serverInfo !== null);
    liveSocket?.send(
      JSON.stringify({
        type: "serverRequest",
        serverRequestId: "sr1",
        kind: "confirm",
        payload: { q: 1 },
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(answers).toEqual([{ echoedKind: "confirm", echoedPayload: { q: 1 } }]);
  });

  it("does not answer once a serverRequestResolved cancels the pending request", async () => {
    let liveSocket: NodeWebSocket | undefined;
    const answers: unknown[] = [];
    const { url } = await startServer({
      onSocket: (socket) => {
        liveSocket = socket;
        socket.on("message", (data) => {
          const frame = JSON.parse(data.toString());
          if (frame.type === "serverResponse") answers.push(frame.payload);
        });
      },
    });
    const bridge = new WsRennetBridge({ url });
    openBridges.push(bridge);
    // A slow handler so the resolved frame lands first.
    bridge.onServerRequest(() => new Promise((r) => setTimeout(() => r("late"), 50)));
    await waitFor(() => bridge.serverInfo !== null);
    liveSocket?.send(
      JSON.stringify({
        type: "serverRequest",
        serverRequestId: "sr2",
        kind: "confirm",
        payload: {},
      }),
    );
    liveSocket?.send(JSON.stringify({ type: "serverRequestResolved", serverRequestId: "sr2" }));
    await new Promise((r) => setTimeout(r, 80));
    expect(answers).toEqual([]); // the late answer was dropped
  });
});

describe("WsRennetBridge with a LATE endpoint (thunk url)", () => {
  it("dials only once the url resolves, and serves normally after", async () => {
    // The desktop shell's cold start: MAIN creates the window before the daemon is healthy
    // (perf audit §2/§6 H1), so the port arrives after the bridge does.
    const stub = await startStub();
    stubs.push(stub);
    let publishPort: (url: string) => void = () => undefined;
    const late = new Promise<string>((resolve) => {
      publishPort = resolve;
    });
    const lifecycle: string[] = [];
    stub.onRequest = (socket, frame) => {
      socket.send(
        JSON.stringify({ type: "response", requestId: frame.requestId, output: { ok: true } }),
      );
    };

    const bridge = trackBridge(
      new WsRennetBridge({
        url: () => late,
        onLifecycle: (event) => lifecycle.push(event.kind),
      }),
    );
    // Nothing has been dialled: no hello reached the server while the endpoint was unknown.
    await new Promise((r) => setTimeout(r, 20));
    expect(stub.helloCount).toBe(0);
    expect(lifecycle).toEqual([]);

    // Issued BEFORE the endpoint arrives: it must WAIT, exactly as an invoke against a string
    // url waits on the socket the constructor already opened — not fail "not connected".
    let settled = false;
    const early = invoke(bridge, "cmd.a", {}).then((output) => {
      settled = true;
      return output;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);

    publishPort(stub.url);
    expect(await early).toEqual({ ok: true });
    expect(stub.helloCount).toBe(1);
    expect(lifecycle).toEqual(["online"]);
  });

  it("reports an endpoint that cannot be resolved as an OUTAGE, not a terminal error", async () => {
    // A daemon that never comes up must ride the supervisor's ordinary offline/reconnect path
    // (which repaints and retries), never `error` — `error` is terminal and stops retrying.
    const lifecycle: string[] = [];
    trackBridge(
      new WsRennetBridge({
        url: () => Promise.reject(new Error("daemon failed to start")),
        autoReconnect: false,
        onLifecycle: (event) => lifecycle.push(event.kind),
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lifecycle).toEqual(["offline"]);
  });

  it("re-asks for the endpoint on each reconnect attempt, so a moved daemon is redialled", async () => {
    // Update-apply recovery re-ensures the daemon and it comes back on a NEW port; a bridge
    // that cached the first answer would reconnect forever to a port nobody is listening on.
    const asked: number[] = [];
    let nth = 0;
    const first = await startStub();
    stubs.push(first);
    const second = await startStub();
    stubs.push(second);
    const lifecycle: string[] = [];

    trackBridge(
      new WsRennetBridge({
        url: () => {
          nth += 1;
          asked.push(nth);
          return Promise.resolve(nth === 1 ? first.url : second.url);
        },
        initialBackoffMs: 10,
        onLifecycle: (event) => lifecycle.push(event.kind),
      }),
    );
    await waitUntil(() => lifecycle.includes("online"));
    expect(first.helloCount).toBe(1);

    first.dropConnections();
    await waitUntil(() => second.helloCount === 1);
    expect(asked).toEqual([1, 2]);
  });
});

/** Poll until `predicate` holds, or fail loudly at the timeout. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
