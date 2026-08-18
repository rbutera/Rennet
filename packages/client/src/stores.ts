// The two injected storage seams the connection runtime persists through (issue #383
// M0). Both are tiny on purpose: a shell supplies its platform's store and NOTHING else
// differs. Desktop and the browser tab implement them over their existing config /
// `localStorage`; a future mobile shell implements them over Keychain/Keystore +
// filesystem. The runtime itself stays free of DOM and Node globals, so it stays
// consumable in React Native.

/**
 * Device-token persistence for a daemon, keyed by its stable id (issue #380 pairing).
 * The runtime reads and writes token material through THIS interface and no other path;
 * token values must never appear in a log line or an error message. Every method is
 * synchronous — the desktop/browser stores are memory- or `localStorage`-backed — but a
 * shell whose backing store is async (a mobile keychain) may return a promise, which the
 * runtime awaits.
 */
export interface TokenStore {
  /** The daemon's saved device token, or `undefined` if it was never paired. */
  get(daemonId: string): string | undefined | Promise<string | undefined>;
  /** Persist (or replace) a daemon's device token. */
  set(daemonId: string, token: string): void | Promise<void>;
  /** Forget a daemon's device token (a revoke / unpair). */
  delete(daemonId: string): void | Promise<void>;
}

/**
 * The last-known projected bootstrap surface for a daemon, so an opening client paints a
 * readable (honestly stale-marked) record before any socket opens rather than a blank
 * screen (issue #383 M0). The shape is opaque to the runtime — it saves whatever the
 * shell hands back from a successful reconcile and returns it verbatim on the next open.
 * The runtime pairs it with a staleness timestamp so a replica can never read as live.
 */
export interface ReplicaStore {
  /** The saved replica for a daemon, or `undefined` if the client never synced it. */
  load(daemonId: string): StoredReplica | undefined | Promise<StoredReplica | undefined>;
  /** Persist a daemon's freshly reconciled bootstrap surface, stamping the save time. */
  save(daemonId: string, surface: unknown): void | Promise<void>;
}

/** A loaded replica: the opaque bootstrap surface plus when it was last reconciled. */
export interface StoredReplica {
  /** The projected bootstrap surface the shell saved (opaque to the runtime). */
  readonly surface: unknown;
  /** Epoch ms when this replica was last reconciled against the daemon — its staleness. */
  readonly savedAt: number;
}
