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
