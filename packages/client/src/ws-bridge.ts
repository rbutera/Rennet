// The WebSocket RennetBridge (issue #378). Implements the `RennetBridge` contract
// over the loopback session-envelope wire the server speaks (server/ws-listener.ts).
// Browser-safe: the global `WebSocket` and `crypto.randomUUID`, no Node imports.
//
// The Electron renderer is client #1 (renderer merges this with the preload's menu
// and platform residue), and every future client — a browser tab, the CLI, mobile —
// reuses it unchanged. So its correlation, fan-out routing, and reconnect are the
// exact behaviour the desktop app exercises daily.

import type {
  AskProjection,
  AttentionEventFrame,
  CommandInput,
  CommandName,
  CommandOutput,
  ProjectDetailProgressEvent,
  ProjectProcessEvent,
  ProjectProgressEvent,
  RennetBridge,
  ReviewAskStreamEvent,
  RoundEvent,
  SessionFrame,
} from "@rennet/protocol";
import {
  checkProtocolCompatibility,
  MIN_COMPATIBLE_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  parseSessionFrame,
} from "@rennet/protocol";
import { ConnectionError } from "./connection-error";

export interface WsRennetBridgeOptions {
  /**
   * The loopback WS URL the server bound, e.g. `ws://127.0.0.1:<port>` — or a THUNK for an
   * endpoint that is not known when the bridge is constructed. The desktop shell creates its
   * window BEFORE the daemon is healthy (perf audit §2/§6 H1), so its port arrives late; the
   * thunk is called once per connection ATTEMPT and awaited. A rejection is reported as
   * `offline`, so a late or never-arriving daemon rides the supervisor's ordinary outage and
   * reconnect path instead of needing a second waiting surface.
   */
  readonly url: string | (() => Promise<string>);
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
  /**
   * Whether the bridge schedules its own capped-backoff reconnect on a dropped socket
   * (default `true` — the historical behaviour every direct caller relies on). A
   * {@link ConnectionSupervisor} constructs the bridge with `false` and owns the retry
   * loop itself (issue #383 M0): it discards the dead bridge and makes a fresh one, so
   * the bridge only ever drives ONE connection and reports its lifecycle.
   */
  readonly autoReconnect?: boolean;
  /**
   * Observe the single connection's lifecycle (issue #383 M0). Fires `online` when the
   * handshake completes, `offline` when the socket closes (retryable), and `error` with
   * a reason when the handshake fails (terminal — an incompatible protocol today, a
   * rejected token when the server grows one). The supervisor drives its reachability
   * state machine off these. Optional: a direct caller omits it.
   */
  readonly onLifecycle?: (event: BridgeLifecycleEvent) => void;
}

/**
 * A single connection's lifecycle signal (issue #383 M0). `online` means the transport
 * is open AND the protocol handshake completed; `offline` means the socket closed and a
 * retry is warranted; `error` means the handshake was rejected and retrying the same way
 * is futile (the supervisor surfaces it as a terminal `error` state).
 */
export type BridgeLifecycleEvent =
  | { readonly kind: "online" }
  | { readonly kind: "offline" }
  | { readonly kind: "error"; readonly reason: string };

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
  readonly #url: string | (() => Promise<string>);
  readonly #initialBackoff: number;
  readonly #maxBackoff: number;
  readonly #deviceToken: string | undefined;
  readonly #autoReconnect: boolean;
  readonly #onLifecycle: ((event: BridgeLifecycleEvent) => void) | undefined;
  #serverInfo: CapturedServerInfo | null = null;
  #serverRequestHandler: ServerRequestHandler | null = null;
  /** In-flight server→client requests; a `serverRequestResolved` deletes an id so a late answer is dropped. */
  readonly #pendingServerRequests = new Set<string>();
  #socket: WebSocket | null = null;
  /** Non-null while a THUNK url is resolving — the window in which there is no socket yet but
   *  the bridge is not disconnected either. `#whenReady` waits on it so an invoke made during a
   *  late endpoint's resolution behaves exactly as it does for a string url (which opens its
   *  socket in the constructor), instead of failing "not connected". */
  #urlPending: Promise<void> | null = null;
  #backoff: number;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;
  #readySocket: WebSocket | null = null;
  #handshakeFailure: { socket: WebSocket; error: Error } | null = null;
  readonly #readyWaiters = new Set<ReadyWaiter>();
  readonly #pending = new Map<string, Pending>();
  // One commandId-keyed map for both progress channels: `project.process` and
  // `project.detail` never share a commandId, so a given id only carries one
  // member's kinds. The public methods below cast their narrower listener in.
  readonly #progressListeners = new Map<string, Set<(event: ProjectProgressEvent) => void>>();
  readonly #askListeners = new Map<string, Set<(event: ReviewAskStreamEvent) => void>>();
  readonly #askProjectionListeners = new Map<string, Set<(projection: AskProjection) => void>>();
  /** Live round-progress listeners, keyed by review id (C15 3.1). */
  readonly #roundListeners = new Map<string, Set<(event: RoundEvent) => void>>();
  /** Daemon-wide attention listeners (#383 batch) — not keyed by review; a raise/clear fans to all. */
  readonly #attentionListeners = new Set<(event: AttentionEventFrame) => void>();

  constructor(options: WsRennetBridgeOptions) {
    this.#url = options.url;
    this.#initialBackoff = options.initialBackoffMs ?? 500;
    this.#maxBackoff = options.maxBackoffMs ?? 8000;
    this.#backoff = this.#initialBackoff;
    this.#deviceToken = options.deviceToken;
    this.#autoReconnect = options.autoReconnect ?? true;
    this.#onLifecycle = options.onLifecycle;
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
    return subscribe(
      this.#progressListeners,
      commandId,
      listener as (event: ProjectProgressEvent) => void,
    );
  }

  onProjectDetailProgress(
    commandId: string,
    listener: (event: ProjectDetailProgressEvent) => void,
  ): () => void {
    return subscribe(
      this.#progressListeners,
      commandId,
      listener as (event: ProjectProgressEvent) => void,
    );
  }

  onAskStream(reviewId: string, listener: (event: ReviewAskStreamEvent) => void): () => void {
    return subscribe(this.#askListeners, reviewId, listener);
  }

  onAskProjection(reviewId: string, listener: (projection: AskProjection) => void): () => void {
    return subscribe(this.#askProjectionListeners, reviewId, listener);
  }

  /**
   * Subscribe to a review's live ROUND progress (C15 3.1), keyed by review id — a slug IS a
   * review id, so the run route subscribes with the id it holds. Like the ask stream, the
   * subscription outlives any single `invoke`: a round runs long past the dispatch call.
   */
  onRoundProgress(reviewId: string, listener: (event: RoundEvent) => void): () => void {
    return subscribe(this.#roundListeners, reviewId, listener);
  }

  /**
   * Subscribe to daemon attention events (#383 batch): `raised` / `cleared` frames the client
   * uses to keep its needs-you set live. Daemon-wide (not keyed), so every listener sees every
   * event. Survives the bridge's own reconnects (the listener set is not cleared on reconnect).
   */
  onAttention(listener: (event: AttentionEventFrame) => void): () => void {
    this.#attentionListeners.add(listener);
    return () => void this.#attentionListeners.delete(listener);
  }

  /**
   * Send a presence frame (issue #383 M1). Best-effort: sent only on a ready (post-handshake)
   * socket; if the socket is not ready it is dropped, because the supervisor re-sends current
   * presence on every `online`. The supervisor gates the CALL on the daemon advertising
   * `attention`, so a daemon that never advertised it never receives a presence frame.
   */
  sendPresence(presence: {
    focused: boolean;
    visible: boolean;
    deviceClass: string;
    focusedReviewId?: string;
  }): void {
    const socket = this.#readySocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(
      JSON.stringify({
        type: "presence",
        focused: presence.focused,
        visible: presence.visible,
        deviceClass: presence.deviceClass,
        ...(presence.focusedReviewId ? { focusedReviewId: presence.focusedReviewId } : {}),
      }),
    );
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
    // A late endpoint is still resolving: no socket yet, but not disconnected either. Waiting
    // terminates once the THUNK settles, in either direction — `#urlPending` is cleared on both
    // branches, before the open (or the offline) it resolves into, so this re-enters `#whenReady`
    // against a real socket or a real rejection. A thunk that never settles waits forever.
    const urlPending = this.#urlPending;
    if (urlPending) return urlPending.then(() => this.#whenReady());
    return Promise.reject(new Error("WsRennetBridge is not connected"));
  }

  #connect(): void {
    if (this.#closed) return;
    const url = this.#url;
    if (typeof url === "string") {
      this.#open(url);
      return;
    }
    // A late endpoint (the desktop's daemon port). Failing to resolve one is an OUTAGE, not a
    // terminal handshake error: the daemon may still be spawning, and the supervisor already
    // paints and retries that state.
    this.#urlPending = url().then(
      (resolved) => {
        this.#urlPending = null;
        if (!this.#closed) this.#open(resolved);
      },
      () => {
        this.#urlPending = null;
        if (this.#closed) return;
        this.#onLifecycle?.({ kind: "offline" });
        if (this.#autoReconnect) this.#scheduleReconnect();
      },
    );
  }

  #open(url: string): void {
    const socket = new WebSocket(url);
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
      // Fail in-flight invokes fast on a dropped connection (no offline queueing). A
      // ConnectionError (not a bare Error) so a consumer — the supervisor, or the UI seam
      // that keeps a live ask stream alive across a mid-turn reconnect (#389) — can tell a
      // connection loss apart from a genuine command failure.
      const error = new ConnectionError("connection lost");
      this.#rejectReady(socket, error);
      this.#rejectPending(error);
      // A handshake failure already emitted `error` and must not be retried; every
      // other close is a retryable `offline`. The supervisor (autoReconnect:false) makes
      // its own fresh bridge, so we only self-reconnect for direct callers.
      if (!this.#closed && this.#handshakeFailure?.socket !== socket) {
        this.#onLifecycle?.({ kind: "offline" });
        if (this.#autoReconnect) this.#scheduleReconnect();
      }
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
    // Terminal: a rejected handshake will be rejected the same way on every retry, so the
    // supervisor surfaces this as `error` and stops (never a silent reconnect loop).
    this.#onLifecycle?.({ kind: "error", reason });
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
        this.#onLifecycle?.({ kind: "online" });
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
        // A handshake rejection correlated to our `hello` (before the socket is ready) is
        // TERMINAL: an incompatible protocol, or a device token the daemon rejected
        // (`unauthorized`, issue #383 — a present-but-invalid token must surface as `error`,
        // never a silent pairing-only fallback the supervisor would retry into). Either way
        // retrying the same hello is futile, so we fail the handshake → `error` lifecycle.
        if (
          this.#readySocket !== socket &&
          frame.requestId === helloClientId &&
          (frame.code === "incompatible_protocol" || frame.code === "unauthorized")
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
      case "askProjection": {
        const listeners = this.#askProjectionListeners.get(frame.sessionId);
        if (listeners) for (const listener of listeners) listener(frame.projection);
        return;
      }
      case "roundProgress": {
        const listeners = this.#roundListeners.get(frame.reviewId);
        if (listeners) for (const listener of listeners) listener(frame.event);
        return;
      }
      case "attentionEvent": {
        for (const listener of this.#attentionListeners) listener(frame);
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
