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
import { PROTOCOL_VERSION, parseSessionFrame } from "@rennet/protocol";

export interface WsRennetBridgeOptions {
  /** The loopback WS URL the server bound, e.g. `ws://127.0.0.1:<port>`. */
  readonly url: string;
  /** First reconnect delay in ms; doubles each attempt up to the ceiling (default 500). */
  readonly initialBackoffMs?: number;
  /** Reconnect backoff ceiling in ms (default 8000). */
  readonly maxBackoffMs?: number;
}

interface Pending {
  readonly resolve: (output: unknown) => void;
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
  #socket: WebSocket | null = null;
  #backoff: number;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;
  readonly #pending = new Map<string, Pending>();
  readonly #progressListeners = new Map<string, Set<(event: ProjectProcessEvent) => void>>();
  readonly #askListeners = new Map<string, Set<(event: ReviewAskStreamEvent) => void>>();

  constructor(options: WsRennetBridgeOptions) {
    this.#url = options.url;
    this.#initialBackoff = options.initialBackoffMs ?? 500;
    this.#maxBackoff = options.maxBackoffMs ?? 8000;
    this.#backoff = this.#initialBackoff;
    this.#connect();
  }

  invoke<K extends CommandName>(name: K, input: CommandInput<K>): Promise<CommandOutput<K>> {
    return this.#whenOpen().then(
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

  /** Tear the bridge down: stop reconnecting, reject pending invokes, close the socket. */
  close(): void {
    this.#closed = true;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#rejectPending(new Error("WsRennetBridge closed"));
    this.#socket?.close();
    this.#socket = null;
  }

  /** A socket that is open now, or the current attempt's open; rejects if disconnected. */
  #whenOpen(): Promise<WebSocket> {
    const socket = this.#socket;
    if (socket && socket.readyState === WebSocket.OPEN) return Promise.resolve(socket);
    if (socket && socket.readyState === WebSocket.CONNECTING) {
      return new Promise((resolve, reject) => {
        socket.addEventListener("open", () => resolve(socket), { once: true });
        socket.addEventListener(
          "close",
          () => reject(new Error("connection closed before it opened")),
          {
            once: true,
          },
        );
      });
    }
    return Promise.reject(new Error("WsRennetBridge is not connected"));
  }

  #connect(): void {
    if (this.#closed) return;
    const socket = new WebSocket(this.#url);
    this.#socket = socket;
    socket.addEventListener("open", () => {
      this.#backoff = this.#initialBackoff;
      // Hello first, before any request the server would reject pre-handshake. WS
      // preserves message order on one connection, so a request queued right after
      // this arrives second and finds the handshake already complete.
      socket.send(
        JSON.stringify({
          type: "hello",
          clientId: crypto.randomUUID(),
          clientType: "rennet-client",
          protocolVersion: PROTOCOL_VERSION,
        }),
      );
    });
    socket.addEventListener("message", (event) => this.#onMessage(event.data));
    socket.addEventListener("close", () => {
      if (this.#socket === socket) this.#socket = null;
      // Fail in-flight invokes fast on a dropped connection (no offline queueing).
      this.#rejectPending(new Error("connection lost"));
      this.#scheduleReconnect();
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

  #onMessage(data: unknown): void {
    let frame: SessionFrame;
    try {
      frame = parseSessionFrame(JSON.parse(typeof data === "string" ? data : String(data)));
    } catch {
      return; // ignore an unparseable frame; the socket stays up
    }
    switch (frame.type) {
      case "response": {
        const pending = this.#pending.get(frame.requestId);
        if (pending) {
          this.#pending.delete(frame.requestId);
          pending.resolve(frame.output);
        }
        return;
      }
      case "rpcError": {
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
      // hello/serverInfo/request are not client-inbound work — ignore them.
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
