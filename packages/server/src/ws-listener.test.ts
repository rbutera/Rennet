import { once } from "node:events";
import { PROTOCOL_VERSION } from "@rennet/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { ExpoPushMessage } from "./expo-push";
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

  it("advertises features.act only when the M2 acting seams are wired (#382 M2)", async () => {
    // With `act`, the phone renders Stop / publish truthfully; without it, a pre-M2-shaped
    // daemon must NOT advertise it (the flag is the honest pre-M2 signal, Finding A + C).
    const dispatch = vi.fn(async () => ({})) as WsListenerDeps["dispatch"];
    const withAct = await startWsListener({ dispatch, serverVersion: "test", act: true });
    listeners.push(withAct);
    expect((await connect(withAct)).serverInfo.features).toMatchObject({ act: true });

    const withoutAct = await startWsListener({ dispatch, serverVersion: "test" });
    listeners.push(withoutAct);
    const { serverInfo } = await connect(withoutAct);
    expect((serverInfo.features as Record<string, unknown>).act).toBeUndefined();
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

describe("WS listener ask-stream broadcast (#389 server half)", () => {
  const listeners: WsListener[] = [];
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    for (const listener of listeners.splice(0)) await listener.close();
  });

  /** Connect a loopback client and complete the handshake. */
  async function connect(listener: WsListener, clientId: string): Promise<WebSocket> {
    const socket = new WebSocket(`ws://127.0.0.1:${listener.port}`);
    sockets.push(socket);
    await once(socket, "open");
    const info = once(socket, "message");
    socket.send(
      JSON.stringify({
        type: "hello",
        clientId,
        clientType: "rennet-client",
        protocolVersion: PROTOCOL_VERSION,
      }),
    );
    await info; // serverInfo
    return socket;
  }

  it("delivers a live ask-stream delta to a RECONNECTED socket, not just the invoker", async () => {
    // Capture the emit sink ws-listener hands dispatch for a `reviewId`-scoped turn.
    let askSink: ((event: unknown) => void) | undefined;
    const dispatch = vi.fn(
      async (_name, _input, ctx?: { emitAskStream?: (event: unknown) => void }) => {
        askSink = ctx?.emitAskStream;
        return { ok: true };
      },
    ) as unknown as WsListenerDeps["dispatch"];
    const listener = await startWsListener({ dispatch, serverVersion: "test" });
    listeners.push(listener);

    // Socket A is the client that STARTED the turn (its socket is about to "drop").
    const socketA = await connect(listener, "invoker");
    const response = once(socketA, "message");
    socketA.send(
      JSON.stringify({
        type: "request",
        requestId: "ask-1",
        command: "review.ask",
        input: { reviewId: "rev-1", commandId: "cmd-1" },
      }),
    );
    await response;
    expect(askSink).toBeTypeOf("function");

    // Socket B is the SAME client after a mid-turn reconnect — a fresh connection that
    // never invoked review.ask. Pre-fix, the emit closed over socket A and B got nothing.
    const socketB = await connect(listener, "reconnected");
    const delta = new Promise<Record<string, unknown>>((resolve) => {
      socketB.on("message", (data) => {
        const frame = JSON.parse(String(data));
        if (frame.type === "askStreamEvent") resolve(frame);
      });
    });

    askSink?.({ kind: "ask-focus", anchor: "widget.ts:1" });

    const frame = await delta;
    expect(frame).toMatchObject({
      type: "askStreamEvent",
      reviewId: "rev-1",
      event: { kind: "ask-focus", anchor: "widget.ts:1" },
    });
  });
});

describe("WS listener attention delivery (#383 M1, attention-notifications)", () => {
  const listeners: WsListener[] = [];
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    for (const listener of listeners.splice(0)) await listener.close();
  });

  function memoryPushTokens(seed: Array<{ deviceId: string; token: string }>) {
    const rows = new Map(
      seed.map((s) => [
        s.deviceId,
        {
          deviceId: s.deviceId,
          token: s.token,
          platform: "ios" as const,
          updatedAt: 0,
          disabledFamilies: [],
        },
      ]),
    );
    return {
      list: () => [...rows.values()],
      delete: (deviceId: string) => void rows.delete(deviceId),
    };
  }

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

  /** Collect every attentionEvent frame the socket receives into an array. */
  function collectAttention(socket: WebSocket): Array<Record<string, unknown>> {
    const frames: Array<Record<string, unknown>> = [];
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data));
      if (frame.type === "attentionEvent") frames.push(frame);
    });
    return frames;
  }

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

  it("advertises the attention feature only when the attention system is wired", async () => {
    const dispatch = vi.fn(async () => ({})) as WsListenerDeps["dispatch"];
    const withAttention = await startWsListener({
      dispatch,
      serverVersion: "test",
      attention: { pushTokens: memoryPushTokens([]) },
    });
    listeners.push(withAttention);
    expect((await connect(withAttention)).serverInfo.features).toMatchObject({ attention: true });

    const withoutAttention = await startWsListener({ dispatch, serverVersion: "test" });
    listeners.push(withoutAttention);
    expect((await connect(withoutAttention)).serverInfo.features).not.toHaveProperty("attention");
  });

  it("raiseAttention broadcasts the live frame in-app and posts a push to a registered device", async () => {
    const dispatch = vi.fn(async () => ({})) as WsListenerDeps["dispatch"];
    let posted: Array<{ to: string; data: Record<string, unknown> }> = [];
    const sendPush = vi.fn(
      async (messages: readonly { to: string; data: Record<string, unknown> }[]) => {
        posted = messages.map((m) => ({ to: m.to, data: m.data }));
        return posted.length;
      },
    );
    const listener = await startWsListener({
      dispatch,
      serverVersion: "test",
      attention: {
        pushTokens: memoryPushTokens([{ deviceId: "phone", token: "tok-phone" }]),
        sendPush,
      },
    });
    listeners.push(listener);
    const { socket } = await connect(listener);
    const frames = collectAttention(socket);

    const item = listener.raiseAttention({
      family: "review-finished",
      reviewId: "rev-1",
      deepLink: "rennet://review/rev-1/digest",
      title: "Review finished",
      body: "acme is ready to read",
    });
    expect(item?.id).toBe("review-finished:rev-1");
    await settle();

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "attentionEvent", event: "raised" });
    const raisedItem = frames[0]?.item as Record<string, unknown>;
    expect(raisedItem.reviewId).toBe("rev-1");

    // The registered device (no focused connection covers it) gets a push.
    expect(sendPush).toHaveBeenCalledOnce();
    expect(posted.map((m) => m.to)).toEqual(["tok-phone"]);
    expect(posted[0]?.data).toMatchObject({
      deviceId: "phone",
      deepLink: "rennet://review/rev-1/digest",
    });
  });

  it("acknowledgeAttention clears and broadcasts the cleared ids (handled once, quiet everywhere)", async () => {
    const dispatch = vi.fn(async () => ({})) as WsListenerDeps["dispatch"];
    const listener = await startWsListener({
      dispatch,
      serverVersion: "test",
      attention: { pushTokens: memoryPushTokens([]), sendPush: vi.fn(async () => 0) },
    });
    listeners.push(listener);
    const { socket } = await connect(listener);
    const frames = collectAttention(socket);

    listener.raiseAttention({
      family: "review-finished",
      reviewId: "rev-1",
      deepLink: "rennet://review/rev-1/digest",
      title: "Review finished",
      body: "",
    });
    expect(listener.activeAttention()).toHaveLength(1);

    const count = listener.acknowledgeAttention({ reviewId: "rev-1" });
    expect(count).toBe(1);
    expect(listener.activeAttention()).toHaveLength(0);
    await settle();

    // The socket saw a raised then a cleared frame; the cleared one names the item's id.
    expect(frames.map((f) => f.event)).toEqual(["raised", "cleared"]);
    expect(frames[1]?.clearedIds).toEqual(["review-finished:rev-1"]);
  });

  it("replays the outstanding attention set to a newly connected socket (#383 batch)", async () => {
    const dispatch = vi.fn(async () => ({})) as WsListenerDeps["dispatch"];
    const listener = await startWsListener({
      dispatch,
      serverVersion: "test",
      attention: { pushTokens: memoryPushTokens([]), sendPush: vi.fn(async () => 0) },
    });
    listeners.push(listener);
    // Outstanding since BEFORE any client connected — the cold-open case.
    listener.raiseAttention({
      family: "ask-pending",
      reviewId: "rev-9",
      deepLink: "rennet://review/rev-9/ask",
      title: "Ask pending",
      body: "",
    });

    const socket = new WebSocket(`ws://127.0.0.1:${listener.port}`);
    sockets.push(socket);
    await once(socket, "open");
    const frames = collectAttention(socket); // attach BEFORE the handshake so replay is captured
    socket.send(
      JSON.stringify({
        type: "hello",
        clientId: "cold",
        clientType: "rennet-client",
        protocolVersion: PROTOCOL_VERSION,
      }),
    );
    await settle();
    // The just-connected socket received the outstanding item as a live raised frame.
    const replayed = frames.find(
      (f) => f.event === "raised" && (f.item as { reviewId?: string })?.reviewId === "rev-9",
    );
    expect(replayed).toBeDefined();
  });

  it("polls receipts after a send and prunes an async dead token (#383 batch)", async () => {
    const dispatch = vi.fn(async () => ({})) as WsListenerDeps["dispatch"];
    const deleted: string[] = [];
    const pushTokens = {
      list: () => [
        {
          deviceId: "phone",
          token: "tok",
          platform: "ios" as const,
          updatedAt: 0,
          disabledFamilies: [],
        },
      ],
      delete: (deviceId: string) => void deleted.push(deviceId),
    };
    const sendPush = vi.fn(
      async (
        messages: readonly ExpoPushMessage[],
        opts?: { onReceipt?: (h: { receiptId: string; token: string }) => void },
      ) => {
        opts?.onReceipt?.({ receiptId: "r1", token: "tok" });
        return messages.length;
      },
    ) as unknown as typeof import("./expo-push").sendExpoPushes;
    const pollReceipts = vi.fn(
      async (
        handles: readonly { receiptId: string; token: string }[],
        opts?: { onDeadToken?: (token: string) => void },
      ) => {
        for (const h of handles) opts?.onDeadToken?.(h.token);
      },
    ) as unknown as typeof import("./expo-push").pollExpoReceipts;
    const listener = await startWsListener({
      dispatch,
      serverVersion: "test",
      attention: { pushTokens, sendPush, pollReceipts, receiptPollDelayMs: 0 },
    });
    listeners.push(listener);
    await connect(listener);
    listener.raiseAttention({
      family: "review-finished",
      reviewId: "rev-1",
      deepLink: "d",
      title: "t",
      body: "",
    });
    await settle(); // send resolves, the delay-0 timer fires, the poll runs
    expect(sendPush).toHaveBeenCalledOnce();
    expect(pollReceipts).toHaveBeenCalledOnce();
    // The receipt reported the token dead ⇒ its device is pruned from the store.
    expect(deleted).toContain("phone");
  });

  it("accepts a presence frame only when attention is advertised (capability-gated)", async () => {
    const dispatch = vi.fn(async () => ({})) as WsListenerDeps["dispatch"];
    const listener = await startWsListener({
      dispatch,
      serverVersion: "test",
      attention: { pushTokens: memoryPushTokens([]), sendPush: vi.fn(async () => 0) },
    });
    listeners.push(listener);
    const { socket } = await connect(listener);
    // A presence frame from a connected client must not error the socket or the listener.
    socket.send(
      JSON.stringify({ type: "presence", focused: true, visible: true, deviceClass: "phone" }),
    );
    await settle();
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });
});
