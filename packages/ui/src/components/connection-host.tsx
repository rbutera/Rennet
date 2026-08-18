import type { RennetBridge } from "@rennet/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import { RennetApp } from "../app";

// The connections surface (issue #381, design D3). ONE component both shells mount —
// the desktop renderer and the served browser tab — that owns "which daemon am I
// attached to". It is transport-agnostic: the shell injects a bridge FACTORY, so `ui`
// never imports `@rennet/client`. Switching daemons is a clean RennetApp REMOUNT keyed
// on the active connection (a daemon is a world; its reviews/threads live server-side),
// never a mid-session bridge mutation.

/** A daemon this window can attach to. The shell turns it into a real bridge. */
export interface ConnectionTarget {
  /** Stable id; the localhost default reserves `"local"`. */
  readonly id: string;
  /** Human label shown in the picker + indicator. */
  readonly label: string;
  /** Host (`127.0.0.1`, a Tailscale IP, a hostname); the shell builds the ws(s) URL. */
  readonly host: string;
  /** Optional explicit port; absent ⇒ the shell's default (serving origin / preload port). */
  readonly port?: number;
  /** The device token for a remote (projected) daemon, obtained via the pairing exchange. */
  readonly deviceToken?: string;
}

/** The shell-injected factory. A remote target carries a token; the local one does not. */
export type BridgeFactory = (target: ConnectionTarget) => RennetBridge & { close?(): void };

/**
 * Reachability the host renders truthfully (issue #383 M0). Structurally a subset of the
 * client runtime's `ConnectionStatus` — declared here because `ui` may not import
 * `@rennet/client`; the shell passes the supervisor's status straight through.
 */
export type ConnectionState = "idle" | "connecting" | "online" | "offline" | "error";
export interface ConnectionStatus {
  readonly state: ConnectionState;
  /** The cause, present only when `state === "error"`. */
  readonly error?: string;
}

/**
 * A live connection to a daemon (issue #383 M0): the `RennetBridge` the app drives plus a
 * `close`. Shells build this over a `ConnectionSupervisor` — the bridge is the supervisor's
 * own `invoke`/`onProgress`/`onAskStream` surface, so the resubscribe registry and the
 * reachability state machine ride underneath every remount, transparently to the app.
 */
export interface Connection {
  readonly bridge: RennetBridge & { close?(): void };
  /**
   * Subscribe to reachability transitions (the supervisor's `subscribe`); fires immediately
   * with the current status. Optional — the legacy `createBridge` path has no status, and
   * the indicator then shows the plain connected label it always did.
   */
  subscribe?(listener: (status: ConnectionStatus) => void): () => void;
  close(): void;
}

/** The shell-injected connection factory (issue #383 M0). Supersedes {@link BridgeFactory}. */
export type ConnectionFactory = (target: ConnectionTarget) => Connection;

export interface ConnectionHostProps {
  /**
   * Build a connection for a target (issue #383 M0). MUST be stable (module-level or
   * memoised) — the host keys remounts on it. Exactly one of `createConnection` /
   * `createBridge` is supplied; `createConnection` is preferred.
   */
  readonly createConnection?: ConnectionFactory;
  /**
   * Legacy bridge factory, adapted to a {@link Connection} when `createConnection` is
   * absent. Kept so existing call sites and tests compile unchanged.
   */
  readonly createBridge?: BridgeFactory;
  /** The always-present default (localhost for the desktop, the serving origin for the browser tab). */
  readonly defaultTarget: ConnectionTarget;
  /** localStorage key for the saved remote-daemon list. */
  readonly storageKey?: string;
}

const DEFAULT_STORAGE_KEY = "rennet.daemons";

interface StoredDaemons {
  readonly daemons: readonly ConnectionTarget[];
  readonly activeId?: string;
}

function endpointKey(target: Pick<ConnectionTarget, "host" | "port">): string | null {
  if (target.host.length === 0 || target.host.trim() !== target.host) return null;
  if (
    target.port !== undefined &&
    (!Number.isInteger(target.port) || target.port < 1 || target.port > 65_535)
  ) {
    return null;
  }
  try {
    const authority = target.port === undefined ? target.host : `${target.host}:${target.port}`;
    const url = new URL(`ws://${authority}`);
    if (
      url.hostname.length === 0 ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.pathname !== "/" ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      return null;
    }
    return `${url.hostname.toLowerCase()}:${target.port ?? ""}`;
  } catch {
    return null;
  }
}

/** A saved daemon must carry a token — an untokened remote is useless (it could only pair). */
function isStoredTarget(value: unknown): value is ConnectionTarget {
  if (!value || typeof value !== "object") return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    typeof t.label === "string" &&
    typeof t.host === "string" &&
    typeof t.deviceToken === "string" &&
    (t.port === undefined || typeof t.port === "number") &&
    endpointKey(t as Pick<ConnectionTarget, "host" | "port">) !== null
  );
}

/** Read the saved remote daemons. A bad/absent blob degrades to none, no migration ceremony. */
function readStoredDaemons(storageKey: string): StoredDaemons {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey);
    if (!raw) return { daemons: [] };
    const parsed = JSON.parse(raw) as StoredDaemons;
    if (!parsed || !Array.isArray(parsed.daemons)) return { daemons: [] };
    const daemons = parsed.daemons.filter(isStoredTarget);
    const activeId =
      typeof parsed.activeId === "string" && daemons.some((target) => target.id === parsed.activeId)
        ? parsed.activeId
        : undefined;
    return { daemons, activeId };
  } catch {
    return { daemons: [] };
  }
}

function persistDaemons(
  storageKey: string,
  daemons: readonly ConnectionTarget[],
  activeId: string,
): void {
  try {
    globalThis.localStorage?.setItem(
      storageKey,
      JSON.stringify({ daemons, activeId } satisfies StoredDaemons),
    );
  } catch {
    return;
  }
}

/** `host[:port]` → `{host, port?}`. IPv6 is out of scope for the typed-in field this phase. */
function parseHostPort(raw: string): { host: string; port?: number } | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const colon = trimmed.lastIndexOf(":");
  if (colon === -1) {
    const endpoint = { host: trimmed };
    return endpointKey(endpoint) === null ? null : endpoint;
  }
  const host = trimmed.slice(0, colon);
  const portText = trimmed.slice(colon + 1);
  const port = Number.parseInt(portText, 10);
  const endpoint = { host, port };
  if (String(port) !== portText || endpointKey(endpoint) === null) {
    return null;
  }
  return endpoint;
}

/**
 * The connection indicator's truthful announcement + dot state. A null status (legacy
 * `createBridge` path, no reachability) reads as connected — the label it always had, so
 * existing call sites are unchanged. Every string keeps "Switch daemon." (the switcher's
 * accessible handle) and names the daemon; only `error` also carries its cause.
 */
function describeConnection(
  label: string,
  status: ConnectionStatus | null,
): { announce: string; dotState: ConnectionState } {
  const state: ConnectionState = status?.state ?? "online";
  const suffix = "Switch daemon.";
  switch (state) {
    case "connecting":
    case "idle":
      return { announce: `Connecting to ${label}. ${suffix}`, dotState: "connecting" };
    case "offline":
      return { announce: `Offline from ${label}, reconnecting. ${suffix}`, dotState: "offline" };
    case "error":
      return {
        announce: `Connection to ${label} failed: ${status?.error ?? "unknown error"}. ${suffix}`,
        dotState: "error",
      };
    default:
      return { announce: `Connected to ${label}. ${suffix}`, dotState: "online" };
  }
}

export function ConnectionHost({
  createConnection,
  createBridge,
  defaultTarget,
  storageKey,
}: ConnectionHostProps) {
  const key = storageKey ?? DEFAULT_STORAGE_KEY;
  // Normalise the two seams to one stable factory: prefer `createConnection`, else adapt the
  // legacy `createBridge` (its returned bridge closes itself). Stable across renders because
  // both inputs are required to be stable (module-level/memoised), like the old contract.
  const makeConnection = useCallback<ConnectionFactory>(
    (target) => {
      if (createConnection) return createConnection(target);
      if (!createBridge) throw new Error("ConnectionHost needs createConnection or createBridge");
      const bridge = createBridge(target);
      return { bridge, close: () => bridge.close?.() };
    },
    [createConnection, createBridge],
  );
  const [initial] = useState(() => readStoredDaemons(key));
  const [saved, setSaved] = useState<readonly ConnectionTarget[]>(initial.daemons);
  const [activeId, setActiveId] = useState(initial.activeId ?? defaultTarget.id);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addLabel, setAddLabel] = useState("");
  const [addHost, setAddHost] = useState("");
  const [addCode, setAddCode] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const hydratedDefault = useMemo(() => {
    if (defaultTarget.deviceToken) return defaultTarget;
    const authority = endpointKey(defaultTarget);
    const matchingSaved =
      authority === null ? undefined : saved.find((target) => endpointKey(target) === authority);
    return matchingSaved
      ? { ...defaultTarget, deviceToken: matchingSaved.deviceToken }
      : defaultTarget;
  }, [defaultTarget, saved]);
  const allTargets = useMemo(() => [hydratedDefault, ...saved], [hydratedDefault, saved]);
  const activeTarget = allTargets.find((target) => target.id === activeId) ?? hydratedDefault;

  const [activeBridge, setActiveBridge] = useState<{
    readonly target: ConnectionTarget;
    readonly bridge: Connection["bridge"];
  } | null>(null);
  // null ⇒ the connection reports no status (legacy `createBridge` path): the indicator keeps
  // its plain connected label. A supervisor-backed connection drives it through every state.
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  useEffect(() => {
    const connection = makeConnection(activeTarget);
    setActiveBridge({ target: activeTarget, bridge: connection.bridge });
    setStatus(null);
    const unsubscribe = connection.subscribe?.((next) => setStatus(next));
    return () => {
      unsubscribe?.();
      connection.close();
    };
  }, [activeTarget, makeConnection]);
  const bridge = activeBridge?.target === activeTarget ? activeBridge.bridge : null;

  const switchTo = useCallback(
    (id: string) => {
      setActiveId(id);
      persistDaemons(key, saved, id);
      setSwitcherOpen(false);
    },
    [key, saved],
  );

  const removeDaemon = useCallback(
    (id: string) => {
      const next = saved.filter((target) => target.id !== id);
      const nextActiveId = activeId === id ? defaultTarget.id : activeId;
      setSaved(next);
      setActiveId(nextActiveId);
      persistDaemons(key, next, nextActiveId);
    },
    [activeId, defaultTarget.id, key, saved],
  );

  const submitAdd = useCallback(async () => {
    setAddError(null);
    const parsed = parseHostPort(addHost);
    if (!parsed) {
      setAddError("Enter a host, optionally host:port.");
      return;
    }
    const code = addCode.trim();
    if (code.length === 0) {
      setAddError("Enter the pairing code shown on the daemon.");
      return;
    }
    const label = addLabel.trim() || parsed.host;
    setAddBusy(true);
    // Exchange the code through a TEMPORARY tokenless bridge (a pairing-only connection).
    // Its only legal command is `pairing.exchange`; the returned token makes the saved
    // daemon a projected connection on every future attach.
    let temp: Connection | undefined;
    try {
      temp = makeConnection({
        id: `pairing:${Date.now()}`,
        label,
        host: parsed.host,
        port: parsed.port,
      });
      const result = await temp.bridge.invoke("pairing.exchange", { code, deviceName: label });
      const target: ConnectionTarget = {
        id: `daemon:${result.deviceId}`,
        label,
        host: parsed.host,
        port: parsed.port,
        deviceToken: result.deviceToken,
      };
      setSaved((current) => {
        const next = [...current.filter((t) => t.id !== target.id), target];
        persistDaemons(key, next, target.id);
        return next;
      });
      setAdding(false);
      setAddLabel("");
      setAddHost("");
      setAddCode("");
      setActiveId(target.id);
      setSwitcherOpen(false);
    } catch (error) {
      setAddError(
        error instanceof Error ? error.message : "Pairing failed. Check the code and host.",
      );
    } finally {
      temp?.close();
      setAddBusy(false);
    }
  }, [addHost, addCode, addLabel, makeConnection, key]);

  return (
    <div className="connection-host">
      <div className="connection-bar">
        {(() => {
          const { announce, dotState } = describeConnection(activeTarget.label, status);
          return (
            <button
              type="button"
              className="connection-indicator"
              data-state={dotState}
              onClick={() => setSwitcherOpen((open) => !open)}
              aria-expanded={switcherOpen}
              aria-label={announce}
            >
              <span className="connection-dot" data-state={dotState} aria-hidden="true" />
              <span className="connection-name">{activeTarget.label}</span>
            </button>
          );
        })()}
        {switcherOpen ? (
          <div className="connection-switcher" role="menu">
            <ul className="connection-list">
              {allTargets.map((target) => (
                <li key={target.id} className="connection-item">
                  <button
                    type="button"
                    className="connection-choose"
                    onClick={() => switchTo(target.id)}
                    aria-current={target.id === activeId}
                  >
                    {target.label}
                    {target.host === defaultTarget.host && target.id === defaultTarget.id
                      ? " (this machine)"
                      : ` — ${target.host}${target.port ? `:${target.port}` : ""}`}
                  </button>
                  {target.id !== defaultTarget.id ? (
                    <button
                      type="button"
                      className="connection-remove"
                      onClick={() => removeDaemon(target.id)}
                      aria-label={`Forget ${target.label}`}
                    >
                      ×
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
            {adding ? (
              <form
                className="connection-add-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitAdd();
                }}
              >
                <label className="connection-field">
                  Name
                  <input
                    value={addLabel}
                    onChange={(e) => setAddLabel(e.target.value)}
                    placeholder="My laptop"
                  />
                </label>
                <label className="connection-field">
                  Host
                  <input
                    value={addHost}
                    onChange={(e) => setAddHost(e.target.value)}
                    placeholder="100.x.y.z or host:port"
                  />
                </label>
                <label className="connection-field">
                  Pairing code
                  <input
                    value={addCode}
                    onChange={(e) => setAddCode(e.target.value)}
                    placeholder="8 characters"
                  />
                </label>
                {addError ? (
                  <p className="connection-error" role="alert">
                    {addError}
                  </p>
                ) : null}
                <div className="connection-add-actions">
                  <button type="submit" disabled={addBusy}>
                    {addBusy ? "Pairing…" : "Pair and add"}
                  </button>
                  <button type="button" onClick={() => setAdding(false)} disabled={addBusy}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button type="button" className="connection-add" onClick={() => setAdding(true)}>
                Add a daemon
              </button>
            )}
            <p className="connection-note">
              A remote daemon shows only repo references, never a host path. Pairing is one-time.
            </p>
          </div>
        ) : null}
      </div>
      {bridge ? <RennetApp key={activeId} bridge={bridge} /> : null}
    </div>
  );
}
