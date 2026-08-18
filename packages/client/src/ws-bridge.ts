// The WebSocket RennetBridge (issue #378). Implements the `RennetBridge` contract
// over the loopback session-envelope wire the server speaks (server/ws-listener.ts).
// Browser-safe: the global `WebSocket` and `crypto.randomUUID`, no Node imports.
//
// The Electron renderer is client #1 (renderer merges this with the preload's menu
// and platform residue), and every future client — a browser tab, the CLI, mobile —
// reuses it unchanged. So its correlation, fan-out routing, and reconnect are the
// exact behaviour the desktop app exercises daily.

import type {
  CommandInput,
  CommandName,
  CommandOutput,
  ProjectProcessEvent,
  RennetBridge,
  ReviewAskStreamEvent,
  SessionFrame,
} from "@rennet/protocol";
import {
  checkProtocolCompatibility,
  MIN_COMPATIBLE_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  parseSessionFrame,
} from "@rennet/protocol";

export interface WsRennetBridgeOptions {
  /** The loopback WS URL the server bound, e.g. `ws://127.0.0.1:<port>`. */
  readonly url: string;
  /** First reconnect delay in ms; doubles each attempt up to the ceiling (default 500). */
  readonly initialBackoffMs?: number;
  /** Reconnect backoff ceiling in ms (default 8000). */
  readonly maxBackoffMs?: number;
  /**
   * A paired device's bearer token (issue #380), sent in every `hello`. Loopback
   * clients omit it. Token persistence is the embedding client's concern (browser
   * localStorage / mobile Keychain in later phases) — the bridge just forwards it.
   */
  readonly deviceToken?: string;
}

/** The server's identity, captured from the `serverInfo` handshake frame (#380). */
export interface CapturedServerInfo {
  readonly version: string;
  readonly features: Readonly<Record<string, boolean>>;
}

/** A server→client request handler: return (or resolve to) the response payload (#380, wire only). */
export type ServerRequestHandler = (kind: string, payload: unknown) => unknown | Promise<unknown>;

interface Pending {
  readonly resolve: (output: unknown) => void;
  readonly reject: (error: Error) => void;
}

interface ReadyWaiter {
  readonly socket: WebSocket;
  readonly resolve: (socket: WebSocket) => void;
  readonly reject: (error: Error) => void;
}

/**
 * A `RennetBridge` over a loopback WebSocket. Correlates `invoke` calls by a
 * generated `requestId`, routes `progressEvent`/`askStreamEvent` push frames to
 * keyed listeners, and reconnects with capped exponential backoff (re-sending the
 * `hello` handshake on every fresh connection). In-flight invokes reject on a
 * dropped connection — no offline queueing (a caller sees a failed command exactly
 * as a thrown in-process dispatch), matching the desktop's pre-WS behaviour.
 */
export class WsRennetBridge implements RennetBridge {
  readonly #url: string;
  readonly #initialBackoff: number;
  readonly #maxBackoff: number;
  readonly #deviceToken: string | undefined;
  #serverInfo: CapturedServerInfo | null = null;
  #serverRequestHandler: ServerRequestHandler | null = null;
  /** In-flight server→client requests; a `serverRequestResolved` deletes an id so a late answer is dropped. */
  readonly #pendingServerRequests = new Set<string>();
  #socket: WebSocket | null = null;
  #backoff: number;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;
  #readySocket: WebSocket | null = null;
  #handshakeFailure: { socket: WebSocket; error: Error } | null = null;
  readonly #readyWaiters = new Set<ReadyWaiter>();
  readonly #pending = new Map<string, Pending>();
  readonly #progressListeners = new Map<string, Set<(event: ProjectProcessEvent) => void>>();
  readonly #askListeners = new Map<string, Set<(event: ReviewAskStreamEvent) => void>>();

  constructor(options: WsRennetBridgeOptions) {
    this.#url = options.url;
    this.#initialBackoff = options.initialBackoffMs ?? 500;
    this.#maxBackoff = options.maxBackoffMs ?? 8000;
    this.#backoff = this.#initialBackoff;
    this.#deviceToken = options.deviceToken;
    this.#connect();
  }

  invoke<K extends CommandName>(name: K, input: CommandInput<K>): Promise<CommandOutput<K>> {
    return this.#whenReady().then(
      (socket) =>
        new Promise<CommandOutput<K>>((resolve, reject) => {
          const requestId = crypto.randomUUID();
          this.#pending.set(requestId, {
            resolve: (output) => resolve(output as CommandOutput<K>),
            reject,
          });
          socket.send(JSON.stringify({ type: "request", requestId, command: name, input }));
        }),
    );
  }

  onProgress(commandId: string, listener: (event: ProjectProcessEvent) => void): () => void {
    return subscribe(this.#progressListeners, commandId, listener);
  }

  onAskStream(reviewId: string, listener: (event: ReviewAskStreamEvent) => void): () => void {
    return subscribe(this.#askListeners, reviewId, listener);
  }

  /** The server identity captured at handshake (version + feature flags), or null before it lands (#380). */
  get serverInfo(): CapturedServerInfo | null {
    return this.#serverInfo;
  }

  /**
   * Register the server→client request handler (issue #380, wire support only). The
   * handler's return value is sent back as the `serverResponse`. Returns an
   * unsubscribe that clears the handler. No product flow drives this yet.
   */
  onServerRequest(handler: ServerRequestHandler): () => void {
    this.#serverRequestHandler = handler;
    return () => {
      if (this.#serverRequestHandler === handler) this.#serverRequestHandler = null;
    };
  }

  #handleServerRequest(
    socket: WebSocket,
    serverRequestId: string,
    kind: string,
    payload: unknown,
  ): void {
    const handler = this.#serverRequestHandler;
    if (!handler) return; // no handler: leave it unanswered (the server resolves on turn-end/disconnect)
    this.#pendingServerRequests.add(serverRequestId);
    Promise.resolve()
      .then(() => handler(kind, payload))
      .then((response) => {
        // Only answer if the request is still pending (a resolved frame may have cancelled it).
        if (!this.#pendingServerRequests.delete(serverRequestId)) return;
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(
            JSON.stringify({ type: "serverResponse", serverRequestId, payload: response }),
          );
        }
      })
      .catch(() => {
        this.#pendingServerRequests.delete(serverRequestId);
      });
  }

  /** Tear the bridge down: stop reconnecting, reject pending invokes, close the socket. */
  close(): void {
    this.#closed = true;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    const error = new Error("WsRennetBridge closed");
    if (this.#socket) this.#rejectReady(this.#socket, error);
    this.#rejectPending(error);
    this.#readySocket = null;
    this.#socket?.close();
    this.#socket = null;
  }

  /** A socket with a compatible completed handshake, or the current attempt's handshake. */
  #whenReady(): Promise<WebSocket> {
    const socket = this.#socket;
    if (socket && this.#readySocket === socket) return Promise.resolve(socket);
    if (socket && this.#handshakeFailure?.socket === socket) {
      return Promise.reject(this.#handshakeFailure.error);
    }
    if (
      socket &&
      (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)
    ) {
      return new Promise((resolve, reject) => {
        this.#readyWaiters.add({ socket, resolve, reject });
      });
    }
    return Promise.reject(new Error("WsRennetBridge is not connected"));
  }

  #connect(): void {
    if (this.#closed) return;
    const socket = new WebSocket(this.#url);
    this.#socket = socket;
    this.#readySocket = null;
    this.#handshakeFailure = null;
    let helloClientId: string | null = null;
    socket.addEventListener("open", () => {
      this.#backoff = this.#initialBackoff;
      // Hello first, before any request the server would reject pre-handshake.
      // Queued invokes stay held until a compatible serverInfo completes it.
      helloClientId = crypto.randomUUID();
      socket.send(
        JSON.stringify({
          type: "hello",
          clientId: helloClientId,
          clientType: "rennet-client",
          protocolVersion: PROTOCOL_VERSION,
          ...(this.#deviceToken ? { deviceToken: this.#deviceToken } : {}),
        }),
      );
    });
    socket.addEventListener("message", (event) =>
      this.#onMessage(socket, helloClientId, event.data),
    );
    socket.addEventListener("close", () => {
      if (this.#socket === socket) this.#socket = null;
      if (this.#readySocket === socket) this.#readySocket = null;
      // Fail in-flight invokes fast on a dropped connection (no offline queueing).
      const error = new Error("connection lost");
      this.#rejectReady(socket, error);
      this.#rejectPending(error);
      if (this.#handshakeFailure?.socket !== socket) this.#scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      // 'error' always precedes 'close'; reconnect is driven by 'close'. Swallow it so
      // an unhandled ErrorEvent never surfaces as a spurious rejection or console noise.
    });
  }

  #scheduleReconnect(): void {
    if (this.#closed || this.#reconnectTimer) return;
    const delay = this.#backoff;
    this.#backoff = Math.min(this.#backoff * 2, this.#maxBackoff);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay);
  }

  #rejectPending(error: Error): void {
    for (const { reject } of this.#pending.values()) reject(error);
    this.#pending.clear();
  }

  #resolveReady(socket: WebSocket): void {
    if (this.#handshakeFailure?.socket === socket) return;
    this.#readySocket = socket;
    for (const waiter of this.#readyWaiters) {
      if (waiter.socket !== socket) continue;
      this.#readyWaiters.delete(waiter);
      waiter.resolve(socket);
    }
  }

  #rejectReady(socket: WebSocket, error: Error): void {
    for (const waiter of this.#readyWaiters) {
      if (waiter.socket !== socket) continue;
      this.#readyWaiters.delete(waiter);
      waiter.reject(error);
    }
  }

  #failHandshake(socket: WebSocket, reason: string): void {
    const error = new Error(reason);
    this.#handshakeFailure = { socket, error };
    if (this.#readySocket === socket) this.#readySocket = null;
    this.#rejectReady(socket, error);
    this.#rejectPending(error);
    socket.close();
  }

  #onMessage(socket: WebSocket, helloClientId: string | null, data: unknown): void {
    let frame: SessionFrame;
    try {
      frame = parseSessionFrame(JSON.parse(typeof data === "string" ? data : String(data)));
    } catch {
      return; // ignore an unparseable frame; the socket stays up
    }
    switch (frame.type) {
      case "serverInfo": {
        const compatibility = checkProtocolCompatibility(
          {
            version: PROTOCOL_VERSION,
            minCompatible: MIN_COMPATIBLE_PROTOCOL_VERSION,
          },
          {
            version: frame.protocolVersion,
            minCompatible: frame.minCompatibleProtocolVersion,
          },
        );
        if (!compatibility.compatible) {
          this.#failHandshake(socket, compatibility.reason);
          return;
        }
        this.#serverInfo = { version: frame.version, features: frame.features };
        this.#resolveReady(socket);
        return;
      }
      case "response": {
        const pending = this.#pending.get(frame.requestId);
        if (pending) {
          this.#pending.delete(frame.requestId);
          pending.resolve(frame.output);
        }
        return;
      }
      case "rpcError": {
        if (
          this.#readySocket !== socket &&
          frame.code === "incompatible_protocol" &&
          frame.requestId === helloClientId
        ) {
          this.#failHandshake(socket, frame.message);
          return;
        }
        const pending = this.#pending.get(frame.requestId);
        if (pending) {
          this.#pending.delete(frame.requestId);
          pending.reject(new Error(frame.message));
        }
        return;
      }
      case "progressEvent": {
        const listeners = this.#progressListeners.get(frame.commandId);
        if (listeners) for (const listener of listeners) listener(frame.event);
        return;
      }
      case "askStreamEvent": {
        const listeners = this.#askListeners.get(frame.reviewId);
        if (listeners) for (const listener of listeners) listener(frame.event);
        return;
      }
      case "serverRequest": {
        this.#handleServerRequest(socket, frame.serverRequestId, frame.kind, frame.payload);
        return;
      }
      case "serverRequestResolved": {
        // The server cleaned up (turn ended / asker gone): drop the pending id so a
        // late handler answer is not sent for a question no longer being asked.
        this.#pendingServerRequests.delete(frame.serverRequestId);
        return;
      }
      // hello/request are not client-inbound work — ignore them.
      default:
        return;
    }
  }
}

/** Add a keyed listener to a fan-out map; the returned unsubscribe detaches exactly it. */
function subscribe<T>(map: Map<string, Set<T>>, key: string, listener: T): () => void {
  let listeners = map.get(key);
  if (!listeners) {
    listeners = new Set<T>();
    map.set(key, listeners);
  }
  listeners.add(listener);
  return () => {
    const current = map.get(key);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) map.delete(key);
  };
}
