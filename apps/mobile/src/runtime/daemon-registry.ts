// The paired-daemon registry (issue #383 M1). One phone pairs with many daemons; each pairing
// yields a stable local daemon id, the daemon's tailnet URL, and the device id the daemon
// minted (pairing.exchange). The registry holds those, builds a shared-runtime supervisor per
// daemon (the M0 ConnectionSupervisor over a WsRennetBridge + keychain token store), and keeps
// the device→daemon index the push router needs (a tapped push carries the device id; the app
// maps it back to which daemon it came from — see lib/deep-links `resolvePushHref`).
//
// The supervisor factory is INJECTED so the registry's bookkeeping unit-tests without opening a
// socket; the real factory (runtime/native supervisor wiring) constructs live supervisors.

import type { ConnectionStatus, Presence } from "@rennet/client";
import type { CommandInput, CommandName, CommandOutput } from "@rennet/protocol";

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
  close(): void;
}

export type SupervisorFactory = (daemon: PairedDaemon) => DaemonSupervisor;

export class DaemonRegistry {
  readonly #byId = new Map<string, DaemonConnection>();
  readonly #daemonIdByDevice = new Map<string, string>();
  readonly #listeners = new Set<() => void>();

  constructor(private readonly createSupervisor: SupervisorFactory) {}

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
