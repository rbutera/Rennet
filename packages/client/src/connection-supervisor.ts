// The connection supervisor (issue #383 M0 — the shared client runtime). React shells
// never construct transports, retry loops, or RPC clients: they hand the supervisor a
// bridge factory and consume its truthful, subscribable reachability state. The
// supervisor owns three things a bare `WsRennetBridge` does not:
//
//   1. A reachability STATE MACHINE (`idle/connecting/online/offline/error`) every shell
//      can paint honestly — `online` only after the handshake, `error` terminal on a
//      rejected handshake (never a silent retry loop).
//   2. The RECONNECT loop (capped backoff) and the RESUBSCRIBE REGISTRY: `onAskStream`
//      /`onProgress` registrations live ABOVE the socket, so a fresh bridge inherits every
//      live subscription and a stream consumer created before an interruption keeps
//      receiving after it — no re-subscribe from the consumer (issue #389, client half).
//   3. The STORE seams (token, replica) and the PRESENCE seam — platform differences live
//      in the injected stores, not in the runtime, which stays free of DOM/Node globals.
//
// The supervisor IS a `RennetBridge` (invoke/onProgress/onAskStream) so a shell drops it
// in wherever a bridge went before; it ADDS `state`/`subscribe`/`setPresence`/`replica`.

import type {
  CommandInput,
  CommandName,
  CommandOutput,
  ProjectProcessEvent,
  RennetBridge,
  ReviewAskStreamEvent,
} from "@rennet/protocol";
import type { BridgeLifecycleEvent, CapturedServerInfo } from "./ws-bridge";
import type { ReplicaStore, StoredReplica, TokenStore } from "./stores";

/** The subset of a bridge the supervisor drives — `WsRennetBridge` satisfies it. */
export interface SupervisedBridge {
  invoke<K extends CommandName>(name: K, input: CommandInput<K>): Promise<CommandOutput<K>>;
  onProgress(commandId: string, listener: (event: ProjectProcessEvent) => void): () => void;
  onAskStream(reviewId: string, listener: (event: ReviewAskStreamEvent) => void): () => void;
  readonly serverInfo: CapturedServerInfo | null;
  close(): void;
}

/** Lifecycle hooks the supervisor wires into every bridge it creates. */
export interface BridgeHooks {
  onLifecycle(event: BridgeLifecycleEvent): void;
}

/** Make one bridge for one connection attempt, with the supervisor's hooks + resolved token. */
export type SupervisedBridgeFactory = (
  hooks: BridgeHooks,
  deviceToken: string | undefined,
) => SupervisedBridge;

/** The truthful reachability state (spec: reachability is a subscribable state machine). */
export type ConnectionState = "idle" | "connecting" | "online" | "offline" | "error";

/** A reachability snapshot: the state, `since` its transition, and the cause when `error`. */
export interface ConnectionStatus {
  readonly state: ConnectionState;
  /** Epoch ms of this transition — pairs with a replica's `savedAt` so stale never reads live. */
  readonly since: number;
  /** The rejection cause, present only when `state === "error"`. */
  readonly error?: string;
}

/** Focus / visibility / device-class presence a shell reports (spec: presence seam). */
export interface Presence {
  readonly focused: boolean;
  readonly visible: boolean;
  readonly deviceClass: string;
}

export interface ConnectionSupervisorOptions {
  /** Build a fresh bridge for one attempt, given the supervisor's lifecycle hooks + token. */
  readonly createBridge: SupervisedBridgeFactory;
  /** Stable daemon id — the token/replica storage key. */
  readonly daemonId: string;
  /** Device-token store; read before each connect (issue #380). Omitted ⇒ a tokenless loopback. */
  readonly tokenStore?: TokenStore;
  /** Last-known-state replica store; loaded before connect, saved on reconcile. */
  readonly replicaStore?: ReplicaStore;
  /** Invoke while not `online`: `reject` fast (default, behavior-neutral) or `queue` for reconnect. */
  readonly offlineInvoke?: "reject" | "queue";
  /** First reconnect delay in ms; doubles to the ceiling (default 500). */
  readonly initialBackoffMs?: number;
  /** Reconnect backoff ceiling in ms (default 8000). */
  readonly maxBackoffMs?: number;
  /**
   * Re-issue `review.reattach` for every subscribed review on `online` (default true), so
   * a surviving turn's persisted state reconciles after a reconnect. The live-delta rebind
   * is a daemon-side follow-on (issue #389 server half); this is the client nudge.
   */
  readonly reconcileOnReconnect?: boolean;
}

type AskListener = (event: ReviewAskStreamEvent) => void;
type ProgressListener = (event: ProjectProcessEvent) => void;

interface QueuedInvoke {
  readonly send: (bridge: SupervisedBridge) => void;
  readonly reject: (error: Error) => void;
}

/** An invoke rejected because the connection was not online — distinguishable by name. */
export class ConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionError";
  }
}

export class ConnectionSupervisor implements RennetBridge {
  readonly #options: ConnectionSupervisorOptions;
  readonly #initialBackoff: number;
  readonly #maxBackoff: number;
  readonly #offlineInvoke: "reject" | "queue";
  readonly #reconcileOnReconnect: boolean;

  #status: ConnectionStatus = { state: "idle", since: Date.now() };
  #bridge: SupervisedBridge | null = null;
  #backoff: number;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;
  #presence: Presence = { focused: true, visible: true, deviceClass: "desktop" };
  #replica: StoredReplica | undefined;

  readonly #statusListeners = new Set<(status: ConnectionStatus) => void>();
  readonly #askRegistry = new Map<string, Set<AskListener>>();
  readonly #progressRegistry = new Map<string, Set<ProgressListener>>();
  // Bridge-level unsubscribes for the CURRENT bridge, so a consumer unsubscribe detaches
  // the live listener too. Rebuilt on every bridge swap (the old bridge's listeners die
  // with it). WeakMap-free: listeners are strong-held by the registry sets anyway.
  #askBridgeUnsub = new Map<AskListener, () => void>();
  #progressBridgeUnsub = new Map<ProgressListener, () => void>();
  #queued: QueuedInvoke[] = [];

  constructor(options: ConnectionSupervisorOptions) {
    this.#options = options;
    this.#initialBackoff = options.initialBackoffMs ?? 500;
    this.#maxBackoff = options.maxBackoffMs ?? 8000;
    this.#backoff = this.#initialBackoff;
    this.#offlineInvoke = options.offlineInvoke ?? "reject";
    this.#reconcileOnReconnect = options.reconcileOnReconnect ?? true;
    void this.#loadReplica();
    this.#connect();
  }

  // ── Reachability ──────────────────────────────────────────────────────────

  /** The current reachability snapshot. */
  get state(): ConnectionStatus {
    return this.#status;
  }

  /** Subscribe to reachability transitions; fires immediately with the current state. */
  subscribe(listener: (status: ConnectionStatus) => void): () => void {
    this.#statusListeners.add(listener);
    listener(this.#status);
    return () => {
      this.#statusListeners.delete(listener);
    };
  }

  /** The server identity captured at handshake, or null before `online`. */
  get serverInfo(): CapturedServerInfo | null {
    return this.#bridge?.serverInfo ?? null;
  }

  #setState(state: ConnectionState, error?: string): void {
    if (this.#status.state === state && this.#status.error === error) return;
    this.#status = { state, since: Date.now(), ...(error === undefined ? {} : { error }) };
    for (const listener of this.#statusListeners) listener(this.#status);
  }

  // ── Connect / reconnect loop ──────────────────────────────────────────────

  #connect(): void {
    if (this.#closed) return;
    this.#setState("connecting");
    // Read the token afresh each attempt (a re-pair could have changed it). The bridge is
    // created only after the token resolves; a close mid-read aborts.
    void Promise.resolve(this.#options.tokenStore?.get(this.#options.daemonId)).then((token) => {
      if (this.#closed) return;
      const bridge = this.#options.createBridge(
        { onLifecycle: (event) => this.#onLifecycle(event) },
        token ?? undefined,
      );
      this.#bridge = bridge;
      this.#wireRegistry(bridge);
    });
  }

  #onLifecycle(event: BridgeLifecycleEvent): void {
    if (this.#closed) return;
    switch (event.kind) {
      case "online": {
        this.#backoff = this.#initialBackoff;
        this.#setState("online");
        this.#flushQueue();
        if (this.#reconcileOnReconnect) this.#reconcile();
        return;
      }
      case "offline": {
        this.#setState("offline");
        this.#scheduleReconnect();
        return;
      }
      case "error": {
        // Terminal: a rejected handshake will reject the same way on retry. Stop, surface
        // the cause, and fail anything queued — never a silent reconnect against a bad token.
        this.#setState("error", event.reason);
        this.#failQueue(new ConnectionError(event.reason));
        return;
      }
    }
  }

  #scheduleReconnect(): void {
    if (this.#closed || this.#reconnectTimer) return;
    const delay = this.#backoff;
    this.#backoff = Math.min(this.#backoff * 2, this.#maxBackoff);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      // Drop the dead bridge (its in-flight invokes already rejected on close) and retry.
      this.#bridge?.close();
      this.#bridge = null;
      this.#connect();
    }, delay);
  }

  // ── Resubscribe registry (issue #389, client half) ────────────────────────

  onAskStream(reviewId: string, listener: AskListener): () => void {
    return this.#register(
      this.#askRegistry,
      this.#askBridgeUnsub,
      reviewId,
      listener,
      (bridge) => bridge.onAskStream(reviewId, listener),
    );
  }

  onProgress(commandId: string, listener: ProgressListener): () => void {
    return this.#register(
      this.#progressRegistry,
      this.#progressBridgeUnsub,
      commandId,
      listener,
      (bridge) => bridge.onProgress(commandId, listener),
    );
  }

  #register<L>(
    registry: Map<string, Set<L>>,
    bridgeUnsub: Map<L, () => void>,
    key: string,
    listener: L,
    wire: (bridge: SupervisedBridge) => () => void,
  ): () => void {
    let set = registry.get(key);
    if (!set) {
      set = new Set<L>();
      registry.set(key, set);
    }
    set.add(listener);
    if (this.#bridge) bridgeUnsub.set(listener, wire(this.#bridge));
    return () => {
      const current = registry.get(key);
      if (current) {
        current.delete(listener);
        if (current.size === 0) registry.delete(key);
      }
      bridgeUnsub.get(listener)?.();
      bridgeUnsub.delete(listener);
    };
  }

  /** Re-attach every registered listener to a freshly created bridge (the resubscribe). */
  #wireRegistry(bridge: SupervisedBridge): void {
    this.#askBridgeUnsub = new Map();
    this.#progressBridgeUnsub = new Map();
    for (const [reviewId, listeners] of this.#askRegistry) {
      for (const listener of listeners) {
        this.#askBridgeUnsub.set(listener, bridge.onAskStream(reviewId, listener));
      }
    }
    for (const [commandId, listeners] of this.#progressRegistry) {
      for (const listener of listeners) {
        this.#progressBridgeUnsub.set(listener, bridge.onProgress(commandId, listener));
      }
    }
  }

  /**
   * Reconcile after `online`: re-issue `review.reattach` for every subscribed review so a
   * surviving turn's persisted state comes back. Best-effort and fire-and-forget — a
   * failure just leaves the last painted state until the next event. (The live-delta
   * rebind is the daemon-side #389 follow-on.)
   */
  #reconcile(): void {
    const bridge = this.#bridge;
    if (!bridge) return;
    for (const reviewId of this.#askRegistry.keys()) {
      void bridge
        .invoke("review.reattach", { commandId: crypto.randomUUID(), reviewId })
        .catch(() => undefined);
    }
  }

  // ── Invoke ────────────────────────────────────────────────────────────────

  invoke<K extends CommandName>(name: K, input: CommandInput<K>): Promise<CommandOutput<K>> {
    if (this.#status.state === "online" && this.#bridge) {
      return this.#bridge.invoke(name, input);
    }
    if (this.#status.state === "error") {
      return Promise.reject(new ConnectionError(this.#status.error ?? "connection failed"));
    }
    if (this.#offlineInvoke === "reject") {
      return Promise.reject(new ConnectionError(`not connected (${this.#status.state})`));
    }
    // queue mode: hold until the next online socket sends it.
    return new Promise<CommandOutput<K>>((resolve, reject) => {
      this.#queued.push({
        send: (bridge) => bridge.invoke(name, input).then(resolve, reject),
        reject,
      });
    });
  }

  #flushQueue(): void {
    const bridge = this.#bridge;
    if (!bridge || this.#queued.length === 0) return;
    const pending = this.#queued;
    this.#queued = [];
    for (const item of pending) item.send(bridge);
  }

  #failQueue(error: Error): void {
    const pending = this.#queued;
    this.#queued = [];
    for (const item of pending) item.reject(error);
  }

  // ── Replica cache (last-known state) ──────────────────────────────────────

  async #loadReplica(): Promise<void> {
    const loaded = await Promise.resolve(this.#options.replicaStore?.load(this.#options.daemonId));
    if (!this.#closed) this.#replica = loaded ?? undefined;
  }

  /** The last-known replica (surface + `savedAt` staleness), or undefined if never synced. */
  get replica(): StoredReplica | undefined {
    return this.#replica;
  }

  /** Save a freshly reconciled bootstrap surface as the daemon's replica, stamping the time. */
  saveReplica(surface: unknown): void {
    this.#replica = { surface, savedAt: Date.now() };
    void Promise.resolve(this.#options.replicaStore?.save(this.#options.daemonId, surface));
  }

  // ── Presence seam (wire-silent) ───────────────────────────────────────────

  /** Record focus/visibility/device-class. Wire-silent until a daemon consumes presence. */
  setPresence(presence: Partial<Presence>): void {
    this.#presence = { ...this.#presence, ...presence };
  }

  /** The last-reported presence. */
  get presence(): Presence {
    return this.#presence;
  }

  // ── Teardown ──────────────────────────────────────────────────────────────

  /** Tear down: stop retrying, close the bridge, fail anything queued. */
  close(): void {
    this.#closed = true;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#failQueue(new ConnectionError("supervisor closed"));
    this.#bridge?.close();
    this.#bridge = null;
    this.#setState("idle");
  }
}
