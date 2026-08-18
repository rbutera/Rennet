import { once } from "node:events";
import { PROTOCOL_VERSION } from "@rennet/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { startWsListener, type WsListener, type WsListenerDeps } from "./ws-listener";

describe("WS listener command lifetime", () => {
  const listeners: WsListener[] = [];
  afterEach(async () => {
    for (const listener of listeners.splice(0)) await listener.close();
  });

  it("does not abort an in-flight command when its client socket closes", async () => {
    let releaseCommand!: (value: unknown) => void;
    const command = new Promise<unknown>((resolve) => {
      releaseCommand = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let markSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    const dispatch = vi.fn(async () => {
      markStarted();
      try {
        return await command;
      } finally {
        markSettled();
      }
    }) as WsListenerDeps["dispatch"];
    const listener = await startWsListener({ dispatch, serverVersion: "test" });
    listeners.push(listener);

    const socket = new WebSocket(`ws://127.0.0.1:${listener.port}`);
    await once(socket, "open");
    const serverInfo = once(socket, "message");
    socket.send(
      JSON.stringify({
        type: "hello",
        clientId: "closing-client",
        clientType: "rennet-client",
        protocolVersion: PROTOCOL_VERSION,
      }),
    );
    expect(JSON.parse(String((await serverInfo)[0]))).toMatchObject({ type: "serverInfo" });
    socket.send(
      JSON.stringify({
        type: "request",
        requestId: "in-flight",
        command: "projects.list",
        input: {},
      }),
    );
    await started;

    const closed = once(socket, "close");
    socket.close();
    await closed;
    releaseCommand({ completed: true });
    await expect(settled).resolves.toBeUndefined();
    expect(dispatch).toHaveBeenCalledOnce();
  });
});

describe("WS listener server-request wire support (#380)", () => {
  const listeners: WsListener[] = [];
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    for (const listener of listeners.splice(0)) await listener.close();
  });

  /** Connect a loopback client, complete the handshake, and return it with the captured serverInfo. */
  async function connect(
    listener: WsListener,
  ): Promise<{ socket: WebSocket; serverInfo: Record<string, unknown> }> {
    const socket = new WebSocket(`ws://127.0.0.1:${listener.port}`);
    sockets.push(socket);
    await once(socket, "open");
    const infoMsg = once(socket, "message");
    socket.send(
      JSON.stringify({
        type: "hello",
        clientId: "c",
        clientType: "rennet-client",
        protocolVersion: PROTOCOL_VERSION,
      }),
    );
    const serverInfo = JSON.parse(String((await infoMsg)[0]));
    return { socket, serverInfo };
  }

  it("advertises features.serverRequests", async () => {
    const dispatch = vi.fn(async () => ({})) as WsListenerDeps["dispatch"];
    const listener = await startWsListener({ dispatch, serverVersion: "test" });
    listeners.push(listener);
    const { serverInfo } = await connect(listener);
    expect(serverInfo.features).toMatchObject({ serverRequests: true });
  });

  it("askConnection round-trips an answer and sends a resolved frame", async () => {
    let capturedConnectionId: string | undefined;
    const dispatch = vi.fn(
      async (_name, _input, ctx?: { progressRecipientId?: string | number }) => {
        capturedConnectionId = String(ctx?.progressRecipientId);
        return { projects: [] };
      },
    ) as WsListenerDeps["dispatch"];
    const listener = await startWsListener({ dispatch, serverVersion: "test" });
    listeners.push(listener);
    const { socket } = await connect(listener);

    // Drive one request so dispatch surfaces this connection's id (= progressRecipientId).
    const firstResponse = once(socket, "message");
    socket.send(
      JSON.stringify({ type: "request", requestId: "r1", command: "projects.list", input: {} }),
    );
    await firstResponse;
    expect(capturedConnectionId).toBeTruthy();

    // The client answers the ask, and asserts it also receives the resolved cleanup frame.
    const frames: Record<string, unknown>[] = [];
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data));
      frames.push(frame);
      if (frame.type === "serverRequest") {
        socket.send(
          JSON.stringify({
            type: "serverResponse",
            serverRequestId: frame.serverRequestId,
            payload: { answer: 42 },
          }),
        );
      }
    });
    const answer = await listener.askConnection(capturedConnectionId as string, "confirm", {
      q: "ok?",
    });
    expect(answer).toEqual({ answer: 42 });
    // The resolved frame lands after the response is processed.
    await new Promise((r) => setTimeout(r, 20));
    expect(frames.some((f) => f.type === "serverRequestResolved")).toBe(true);
  });

  it("askConnection rejects when the connection drops before answering", async () => {
    let capturedConnectionId: string | undefined;
    const dispatch = vi.fn(
      async (_name, _input, ctx?: { progressRecipientId?: string | number }) => {
        capturedConnectionId = String(ctx?.progressRecipientId);
        return { projects: [] };
      },
    ) as WsListenerDeps["dispatch"];
    const listener = await startWsListener({ dispatch, serverVersion: "test" });
    listeners.push(listener);
    const { socket } = await connect(listener);
    const first = once(socket, "message");
    socket.send(
      JSON.stringify({ type: "request", requestId: "r1", command: "projects.list", input: {} }),
    );
    await first;

    const pending = listener.askConnection(capturedConnectionId as string, "confirm", {});
    socket.close();
    await expect(pending).rejects.toThrow();
  });

  it("askConnection rejects an unknown connection id", async () => {
    const dispatch = vi.fn(async () => ({})) as WsListenerDeps["dispatch"];
    const listener = await startWsListener({ dispatch, serverVersion: "test" });
    listeners.push(listener);
    await expect(listener.askConnection("nope", "k", {})).rejects.toThrow();
  });
});
