import type { AddressInfo } from "node:net";
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

function startStub(): Promise<Stub> {
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
          socket.send(
            JSON.stringify({
              type: "serverInfo",
              version: "stub",
              protocolVersion: 1,
              minCompatibleProtocolVersion: 1,
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

  it("routes progress and ask-stream push frames to their keyed listeners", async () => {
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
    bridge.onProgress("cmd-1", (event) => progress.push(event));
    bridge.onAskStream("rev-1", (event) => asks.push(event));

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
    await waitFor(() => progress.length === 1 && asks.length === 1);
    expect(progress).toEqual([{ kind: "repo-error", repo: "r", message: "m" }]);
    expect(asks).toEqual([{ kind: "ask-focus", anchor: "a" }]);
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
