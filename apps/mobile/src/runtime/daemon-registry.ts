// The paired-daemon registry (issue #383 M1). One phone pairs with many daemons; each pairing
// yields a stable local daemon id, the daemon's tailnet URL, and the device id the daemon
// minted (pairing.exchange). The registry holds those, builds a shared-runtime supervisor per
// daemon (the M0 ConnectionSupervisor over a WsRennetBridge + keychain token store), and keeps
// the device→daemon index the push router needs (a tapped push carries the device id; the app
// maps it back to which daemon it came from — see lib/deep-links `resolvePushHref`).
//
// The supervisor factory is INJECTED so the registry's bookkeeping unit-tests without opening a
// socket; the real factory (runtime/native supervisor wiring) constructs live supervisors.

import type { ConnectionStatus, Presence, StoredReplica } from "@rennet/client";
import type {
  AskProjection,
  AttentionAction,
  AttentionEventFrame,
  CommandInput,
  CommandName,
  CommandOutput,
  ProjectProcessEvent,
} from "@rennet/protocol";

/** A paired daemon as the app tracks it. */
export interface PairedDaemon {
  /** Stable local id (the storage key for the token/replica stores). */
  readonly id: string;
  /** Human label shown in the connections list (e.g. "home-mac"). */
  readonly name: string;
  /** The daemon's tailnet WebSocket URL (e.g. `ws://100.84.12.9:<port>`). */
  readonly url: string;
  /** The device id the daemon minted at pairing — the push router's key back to this daemon. */
  readonly deviceId: string;
}

/** The per-daemon runtime surface the screens read: its supervisor + last reachability. */
export interface DaemonConnection {
  readonly daemon: PairedDaemon;
  readonly supervisor: DaemonSupervisor;
  status: ConnectionStatus;
}

/** The slice of the M0 ConnectionSupervisor the registry drives (kept minimal for injection). */
export interface DaemonSupervisor {
  invoke<K extends CommandName>(name: K, input: CommandInput<K>): Promise<CommandOutput<K>>;
  subscribe(listener: (status: ConnectionStatus) => void): () => void;
  setPresence(presence: Partial<Presence>): void;
  /** Subscribe to this daemon's attention broadcasts (#383 batch) — keeps needs-you live. */
  onAttention(listener: (event: AttentionEventFrame) => void): () => void;
  /** Subscribe to durable ask-projection replacements that invalidate an open publish preview.
   *  This is the session ASK LOG (dispositions), not the retired orchestrator chat stream. */
  onAskProjection(reviewId: string, listener: (projection: AskProjection) => void): () => void;
  /** Subscribe to a long-running command's progress (kickoff `onProgress`, #382 M2), by commandId. */
  onProgress(commandId: string, listener: (event: ProjectProcessEvent) => void): () => void;
  /** The last-known replica surface (offline paint), or undefined if never synced. */
  readonly replica: StoredReplica | undefined;
  /** Save a freshly reconciled bootstrap surface as this daemon's replica. */
  saveReplica(surface: unknown): void;
  /** Whether this daemon advertised the attention capability (gates push registration, #383). */
  attentionAdvertised(): boolean;
  /**
   * Whether this daemon advertised the `act` capability — the M2 acting seams (`review.interrupt`,
   * `publish.compose`). The turn screen's Stop and the publish surface gate on it so a pre-M2
   * daemon shows them truthfully disabled / needs-updating, never a silent no-op (#382 M2).
   */
  actAdvertised(): boolean;
  close(): void;
}

export type SupervisorFactory = (daemon: PairedDaemon) => DaemonSupervisor;

/** The attention families that mean "this review needs you" — the pinnable, high-priority set. */
const NEEDS_YOU_FAMILIES = new Set(["ask-pending", "review-finished", "turn-failed"]);

export class DaemonRegistry {
  readonly #byId = new Map<string, DaemonConnection>();
  readonly #daemonIdByDevice = new Map<string, string>();
  readonly #listeners = new Set<() => void>();
  // Live needs-you set from attention broadcasts (#383 batch): reviewId ⇢ its active high-priority
  // attention ids. A review is needs-you while any high-priority attention on it is unresolved.
  readonly #attentionIdsByReview = new Map<string, Set<string>>();
  readonly #reviewByAttentionId = new Map<string, string>();
  // The answer chips carried on the latest ask-pending attention per review (#382 M2), so the
  // turn/ask screen renders the daemon's chips when it attaches them. Cleared when the ask clears.
  readonly #askActionsByReview = new Map<string, readonly AttentionAction[]>();

  constructor(private readonly createSupervisor: SupervisorFactory) {}

  /** The live needs-you review set from attention broadcasts (augments the projected summary). */
  needsYouReviewIds(): ReadonlySet<string> {
    return new Set(this.#attentionIdsByReview.keys());
  }

  /** The answer chips on a review's active ask, or [] — the shade/in-app answer options (#382 M2). */
  askActionsFor(reviewId: string): readonly AttentionAction[] {
    return this.#askActionsByReview.get(reviewId) ?? [];
  }

  /** Apply one attention frame to the live needs-you set; emits if it changed anything. */
  #applyAttention(frame: AttentionEventFrame): void {
    if (frame.event === "raised" && frame.item) {
      const { id, family, reviewId } = frame.item;
      if (!reviewId || !NEEDS_YOU_FAMILIES.has(family)) return;
      this.#reviewByAttentionId.set(id, reviewId);
      const set = this.#attentionIdsByReview.get(reviewId) ?? new Set<string>();
      set.add(id);
      this.#attentionIdsByReview.set(reviewId, set);
      // Keep the ask's answer chips for the screen (#382 M2); a non-ask family carries none.
      if (family === "ask-pending" && frame.item.actions)
        this.#askActionsByReview.set(reviewId, frame.item.actions);
      this.#emit();
    } else if (frame.event === "cleared" && frame.clearedIds) {
      let changed = false;
      for (const id of frame.clearedIds) {
        const reviewId = this.#reviewByAttentionId.get(id);
        if (!reviewId) continue;
        this.#reviewByAttentionId.delete(id);
        const set = this.#attentionIdsByReview.get(reviewId);
        set?.delete(id);
        if (set && set.size === 0) this.#attentionIdsByReview.delete(reviewId);
        if (id.startsWith("ask-pending:")) this.#askActionsByReview.delete(reviewId);
        changed = true;
      }
      if (changed) this.#emit();
    }
  }

  /** Every paired daemon connection, in pairing order. */
  list(): DaemonConnection[] {
    return [...this.#byId.values()];
  }

  /** A paired daemon by id, or undefined. */
  get(daemonId: string): DaemonConnection | undefined {
    return this.#byId.get(daemonId);
  }

  /** Map a daemon-minted device id back to its local daemon id (the push router's lookup). */
  daemonIdForDevice(deviceId: string): string | undefined {
    return this.#daemonIdByDevice.get(deviceId);
  }

  /** Subscribe to registry changes (a daemon added/removed, or a reachability transition). */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Add a freshly paired daemon: build its supervisor and start tracking its reachability. */
  add(daemon: PairedDaemon): DaemonConnection {
    const existing = this.#byId.get(daemon.id);
    if (existing) return existing;
    const supervisor = this.createSupervisor(daemon);
    const connection: DaemonConnection = {
      daemon,
      supervisor,
      status: { state: "connecting", since: Date.now() },
    };
    supervisor.subscribe((status) => {
      connection.status = status;
      this.#emit();
    });
    // Keep the needs-you set live off this daemon's attention broadcasts (#383 batch). The
    // connect-time replay hands the outstanding set on connect, so a cold open pins correctly.
    supervisor.onAttention((frame) => this.#applyAttention(frame));
    this.#byId.set(daemon.id, connection);
    this.#daemonIdByDevice.set(daemon.deviceId, daemon.id);
    this.#emit();
    return connection;
  }

  /** Revoke/forget a daemon: close its supervisor and drop it from every index. */
  remove(daemonId: string): void {
    const connection = this.#byId.get(daemonId);
    if (!connection) return;
    connection.supervisor.close();
    this.#byId.delete(daemonId);
    this.#daemonIdByDevice.delete(connection.daemon.deviceId);
    this.#emit();
  }

  /** Report presence to every daemon (focus/visibility), naming the focused review to one. */
  reportPresence(presence: Partial<Presence>, focusedDaemonId?: string): void {
    for (const connection of this.#byId.values()) {
      const scoped =
        connection.daemon.id === focusedDaemonId
          ? presence
          : { ...presence, focusedReviewId: undefined };
      connection.supervisor.setPresence(scoped);
    }
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}
