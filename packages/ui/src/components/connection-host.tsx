import type { ProjectKind, RennetBridge } from "@rennet/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  /** Epoch ms of this transition — the outage banner's elapsed-time anchor. */
  readonly since?: number;
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

/**
 * The outcome of resolving which daemon should serve a project path (WSL connect flow). The
 * shell (desktop) owns the locus detection + daemon spawn (it may import `@rennet/core` and
 * the preload; `ui` may not), and hands back a plain result:
 * - `switched: true` + `target` → this path lives in a WSL distro; attach ITS in-distro daemon
 *   (a tokenless LOCAL target at the resolved loopback port). `repoPath` is the path
 *   translated to its distro-native form, which the distro daemon understands.
 * - `switched: false`, no error → a host path; nothing to switch (host behaviour is unchanged).
 * - `error` → the distro has no usable Node / is unreachable; honest failure copy for the app.
 */
export interface DaemonResolution {
  readonly switched: boolean;
  readonly target?: ConnectionTarget;
  readonly repoPath?: string;
  readonly error?: string;
}

/** The app-facing capability the shell threads down: pick a path → connect its daemon.
 *  `add` marks the FRONT-DOOR add flow (vs. a review capture): a WSL switch then queues a
 *  pending-ADD (discover + projects.add) on the distro daemon rather than a pending-capture. */
export type ConnectDaemonForPath = (
  path: string,
  add?: { readonly kind: ProjectKind },
) => Promise<{ switched: boolean; error?: string }>;

/** Append one debug line to the desktop's `wsl-connect.log` (shell-owned; structurally the
 *  preload's `logWslConnect`). Absent in the browser shell — the front-door add trace is then
 *  simply not written. Threaded to the app so the pending-add completion is logged distro-side. */
export type LogWslConnect = (entry: {
  readonly event: string;
  readonly path?: string;
  readonly detail?: Record<string, unknown>;
}) => void;

/** A distro-native path + its project kind, queued for the remounted FrontDoor to add ON the
 *  distro daemon (the front-door sibling of {@link ConnectionHostProps} pending-repo capture). */
export interface PendingAdd {
  readonly path: string;
  readonly kind: ProjectKind;
}

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
  /**
   * The desktop shell's "which daemon serves this path" resolver (WSL connect flow). Absent in
   * the browser shell (no WSL, no preload) — then the app never sees `connectDaemonForPath`
   * and every pick stays on the current daemon, exactly as before. When present, the host wraps
   * it into the {@link ConnectDaemonForPath} capability it passes to the app: on a `switched`
   * resolution it activates the returned distro target (a clean remount) and stashes the
   * distro-native path so the freshly mounted app captures the repo THERE.
   */
  readonly resolveDaemonTarget?: (path: string) => Promise<DaemonResolution>;
  /**
   * The desktop shell's wsl-connect debug logger (the preload's `logWslConnect`). Absent in the
   * browser shell. Threaded to the app so the FRONT-DOOR add flow can log its completion on the
   * distro daemon — the `detect`/`switch` lines are already written by {@link resolveDaemonTarget}.
   */
  readonly logWslConnect?: LogWslConnect;
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

/** How long the reconnected note stays up before clearing itself. */
const RESTORED_NOTE_MS = 4000;

/** Outage elapsed time in plain units — a stale window can sit dead for hours. */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * The daemon-lost banner (PR #405 follow-up). When the socket drops, every surface says
 * so instead of sitting on innocent loading copy — a fixed, non-modal strip; the app
 * keeps rendering whatever it has. `outage` holds through the supervisor's own
 * connecting/offline retry oscillation (no flicker, and the `since` anchor of the FIRST
 * drop survives newer transitions), `failed` is the supervisor's terminal error (it
 * stopped retrying; Retry re-dials), and `restored` is a brief reconnected note that
 * clears itself. Null while the connection has never faltered — the initial connect is
 * the indicator's job, not a banner.
 *
 * `everOnline` keeps the copy honest: a failed INITIAL dial also surfaces as lifecycle
 * "offline" (ws-bridge maps every non-handshake close there), so a cold boot against an
 * unreachable daemon must say "can't reach" — never "lost", which claims a connection
 * that never existed — and its first successful handshake clears silently instead of
 * announcing "Reconnected" for a connection that was never established.
 */
type BannerState =
  | { readonly kind: "outage"; readonly since: number }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "restored" };

interface BannerFold {
  readonly everOnline: boolean;
  readonly banner: BannerState | null;
}

const INITIAL_FOLD: BannerFold = { everOnline: false, banner: null };

/** Fold one reachability transition into the banner state (pure, so it is testable). */
function foldStatus(current: BannerFold, status: ConnectionStatus): BannerFold {
  const { everOnline, banner } = current;
  switch (status.state) {
    case "offline":
      return banner?.kind === "outage"
        ? current
        : { everOnline, banner: { kind: "outage", since: status.since ?? Date.now() } };
    case "error":
      return {
        everOnline,
        banner: { kind: "failed", reason: status.error ?? "connection failed" },
      };
    case "online":
      // Only a LOST established connection earns a reconnected note; a first handshake
      // after a can't-reach spell (or a clean boot) clears silently.
      return {
        everOnline: true,
        banner: banner?.kind === "outage" && everOnline ? { kind: "restored" } : null,
      };
    default:
      // connecting/idle: a reconnect attempt in flight keeps the outage banner up.
      return current;
  }
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
  resolveDaemonTarget,
  logWslConnect,
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
  // A repo path the NEXT-mounted app should capture on itself — set when a WSL pick switches
  // us onto a distro daemon, so the freshly remounted app adds the repo THERE (the switching
  // app is already tearing down). The app clears it via `onPendingRepoConsumed`.
  const [pendingRepoPath, setPendingRepoPath] = useState<string | null>(null);
  // The front-door sibling of `pendingRepoPath`: a distro-native path (+kind) the NEXT-mounted
  // FrontDoor should ADD on itself (discover + projects.add), set when a WSL pick in the add flow
  // switches us onto a distro daemon. The remounted FrontDoor clears it via `onPendingAddConsumed`.
  const [pendingAddPath, setPendingAddPath] = useState<PendingAdd | null>(null);
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
  const [fold, setFold] = useState(INITIAL_FOLD);
  const banner = fold.banner;
  // The re-dial seam: Retry bumps the nonce, tearing down the dead connection and
  // dialing afresh through the same effect — no parallel supervision machinery.
  const [retryNonce, setRetryNonce] = useState(0);
  // Which target the fold belongs to. A same-target redial (Retry) keeps the ever-online
  // latch and carries the failed banner into an outage — only a TARGET change resets the
  // fold, or an established-then-lost daemon would read "Can't reach" (implying it never
  // connected) after a Retry, and its eventual reconnect would lose the note.
  const foldTargetId = useRef<string | null>(null);
  useEffect(() => {
    void retryNonce;
    const connection = makeConnection(activeTarget);
    setActiveBridge({ target: activeTarget, bridge: connection.bridge });
    setStatus(null);
    const sameTarget = foldTargetId.current === activeTarget.id;
    foldTargetId.current = activeTarget.id;
    setFold((current) => {
      if (!sameTarget) return INITIAL_FOLD;
      // Retry on a terminal error: the redial is in flight, so the banner becomes an
      // outage ("lost" / "can't reach" per the latch) instead of vanishing mid-dial.
      return current.banner?.kind === "failed"
        ? { everOnline: current.everOnline, banner: { kind: "outage", since: Date.now() } }
        : current;
    });
    const unsubscribe = connection.subscribe?.((next) => {
      setStatus(next);
      setFold((current) => foldStatus(current, next));
    });
    return () => {
      unsubscribe?.();
      connection.close();
    };
  }, [activeTarget, makeConnection, retryNonce]);
  // Tick the outage clock once a second while the banner shows elapsed time. The banner
  // object is identity-stable across the retry oscillation, so the interval survives it.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (banner?.kind !== "outage") return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [banner]);
  // The reconnected note clears itself; an outage arriving meanwhile wins the race.
  useEffect(() => {
    if (banner?.kind !== "restored") return;
    const timer = setTimeout(() => {
      setFold((current) =>
        current.banner?.kind === "restored" ? { ...current, banner: null } : current,
      );
    }, RESTORED_NOTE_MS);
    return () => clearTimeout(timer);
  }, [banner]);
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

  // Add-or-replace a LOCAL (tokenless) target and make it active — a clean RennetApp remount,
  // reusing the same target list + activeId the switcher drives. A WSL distro daemon is just a
  // loopback target at the resolved port; it needs no device token (it is on THIS machine), so
  // it is deliberately not a `isStoredTarget` (readStoredDaemons drops it on reload — the distro
  // daemon is re-resolved from the path each session, never restored from a stale port).
  const activateLocalTarget = useCallback(
    (target: ConnectionTarget) => {
      setSaved((current) => {
        const next = [...current.filter((t) => t.id !== target.id), target];
        persistDaemons(key, next, target.id);
        return next;
      });
      setActiveId(target.id);
      setSwitcherOpen(false);
    },
    [key],
  );

  // The capability the app calls after a repo pick: resolve the path's daemon (desktop-owned),
  // and if it lives in a WSL distro, switch onto that distro's daemon + queue the distro-native
  // repo path for the remounted app to capture. Returns the app-facing {switched, error?} shape;
  // a host path (or no resolver) is {switched:false} and the app proceeds on the current daemon.
  const connectDaemonForPath = useCallback<ConnectDaemonForPath>(
    async (path, add) => {
      if (!resolveDaemonTarget) return { switched: false };
      const resolution = await resolveDaemonTarget(path);
      if (resolution.error) return { switched: false, error: resolution.error };
      if (resolution.switched && resolution.target) {
        const repoPath = resolution.repoPath ?? path;
        // The add flow queues a pending-ADD (discover + projects.add on the distro daemon); a
        // review capture queues the pending-repo capture. Both survive the remount below.
        if (add) setPendingAddPath({ path: repoPath, kind: add.kind });
        else setPendingRepoPath(repoPath);
        activateLocalTarget(resolution.target);
        return { switched: true };
      }
      return { switched: false };
    },
    [resolveDaemonTarget, activateLocalTarget],
  );

  const { announce, dotState } = describeConnection(activeTarget.label, status);
  // The dot is a redundant non-text cue (the indicator's aria-label carries the truth):
  // green when live, ink-faint while idle/connecting, danger when offline/failed.
  const dotColor =
    dotState === "online"
      ? "bg-green"
      : dotState === "offline" || dotState === "error"
        ? "bg-danger"
        : "bg-ink-faint";
  const connectionBar = (
    <div className="connection-bar relative ml-auto inline-flex items-center">
      <button
        type="button"
        className="connection-indicator inline-flex cursor-pointer items-center gap-1.5 rounded-chip border border-line bg-surface px-2.5 py-1 text-xs text-ink-soft hover:bg-raised"
        data-state={dotState}
        onClick={() => setSwitcherOpen((open) => !open)}
        aria-expanded={switcherOpen}
        aria-label={announce}
      >
        <span
          className={`connection-dot h-2 w-2 flex-none rounded-full ${dotColor}`}
          data-state={dotState}
          aria-hidden="true"
        />
        <span className="connection-name text-ink">{activeTarget.label}</span>
      </button>
      {switcherOpen ? (
        <div
          className="connection-switcher absolute left-0 top-full z-40 mt-1.5 min-w-[280px] rounded-surface border border-line bg-overlay p-2 shadow-overlay"
          role="menu"
        >
          <ul className="connection-list mb-1.5 list-none">
            {allTargets.map((target) => (
              <li key={target.id} className="connection-item flex items-center gap-1.5">
                <button
                  type="button"
                  className="connection-choose flex-1 cursor-pointer rounded-chip px-2 py-1.5 text-left text-sm text-ink hover:bg-raised aria-[current=true]:bg-accent-soft"
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
                    className="connection-remove flex-none cursor-pointer px-1 text-sm text-ink-faint hover:text-danger"
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
              className="connection-add-form flex flex-col gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                void submitAdd();
              }}
            >
              <label className="connection-field flex flex-col gap-1 text-2xs text-ink-faint">
                Name
                <input
                  className="rounded-chip border border-line bg-surface px-2 py-1.5 text-sm text-ink"
                  value={addLabel}
                  onChange={(e) => setAddLabel(e.target.value)}
                  placeholder="My laptop"
                />
              </label>
              <label className="connection-field flex flex-col gap-1 text-2xs text-ink-faint">
                Host
                <input
                  className="rounded-chip border border-line bg-surface px-2 py-1.5 text-sm text-ink"
                  value={addHost}
                  onChange={(e) => setAddHost(e.target.value)}
                  placeholder="100.x.y.z or host:port"
                />
              </label>
              <label className="connection-field flex flex-col gap-1 text-2xs text-ink-faint">
                Pairing code
                <input
                  className="rounded-chip border border-line bg-surface px-2 py-1.5 text-sm text-ink"
                  value={addCode}
                  onChange={(e) => setAddCode(e.target.value)}
                  placeholder="8 characters"
                />
              </label>
              {addError ? (
                <p className="connection-error text-2xs text-danger" role="alert">
                  {addError}
                </p>
              ) : null}
              <div className="connection-add-actions flex gap-1.5">
                <button
                  type="submit"
                  className="cursor-pointer rounded-control bg-accent-fill px-3 py-1.5 text-xs font-semibold text-accent-ink disabled:opacity-60"
                  disabled={addBusy}
                >
                  {addBusy ? "Pairing…" : "Pair and add"}
                </button>
                <button
                  type="button"
                  className="cursor-pointer rounded-control border border-line px-3 py-1.5 text-xs text-ink-soft hover:bg-raised disabled:opacity-60"
                  onClick={() => setAdding(false)}
                  disabled={addBusy}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              className="connection-add w-full cursor-pointer rounded-chip border border-dashed border-line-strong px-2 py-1.5 text-xs text-ink-soft hover:bg-raised"
              onClick={() => setAdding(true)}
            >
              Add a daemon
            </button>
          )}
          <p className="connection-note mt-2 text-2xs leading-relaxed text-ink-faint">
            A remote daemon shows only repo references, never a host path. Pairing is one-time.
          </p>
        </div>
      ) : null}
    </div>
  );

  const daemonBanner =
    banner === null ? null : (
      // A fixed, non-modal strip over whatever the app is showing — nothing blocks. It
      // sits at top-14 (below the h-14 titlebar) so a min-h-screen surface never pushes
      // it off-screen, and clears the fixed top-3/right-4 Files/Canvases toggle. Danger
      // ground for a live/failed outage; the transient "restored" note flips to green.
      <div
        className="connection-banner fixed inset-x-0 top-14 z-30 flex items-center justify-center gap-3 border-b border-danger bg-danger-soft px-4 py-2 text-xs text-danger data-[kind=restored]:border-green-line data-[kind=restored]:bg-green-soft data-[kind=restored]:text-green"
        data-kind={banner.kind}
        role="status"
      >
        {banner.kind === "outage" ? (
          <span className="connection-banner-text">
            {fold.everOnline
              ? "Connection to the review daemon lost — reconnecting… ("
              : "Can't reach the review daemon — retrying… ("}
            {formatElapsed(now - banner.since)})
          </span>
        ) : banner.kind === "failed" ? (
          <>
            <span className="connection-banner-text">
              Connection to the review daemon failed: {banner.reason}
            </span>
            <button
              type="button"
              className="connection-banner-retry flex-none cursor-pointer rounded-chip border border-danger px-2.5 py-1 text-xs font-semibold text-danger hover:bg-danger hover:text-canvas"
              onClick={() => setRetryNonce((nonce) => nonce + 1)}
            >
              Retry
            </button>
          </>
        ) : (
          <span className="connection-banner-text">Reconnected to the review daemon.</span>
        )}
      </div>
    );

  return bridge ? (
    <>
      <RennetApp
        key={activeId}
        bridge={bridge}
        connectionSlot={connectionBar}
        connectDaemonForPath={resolveDaemonTarget ? connectDaemonForPath : undefined}
        pendingRepoPath={pendingRepoPath ?? undefined}
        onPendingRepoConsumed={() => setPendingRepoPath(null)}
        pendingAddPath={pendingAddPath ?? undefined}
        onPendingAddConsumed={() => setPendingAddPath(null)}
        logWslConnect={logWslConnect}
      />
      {daemonBanner}
    </>
  ) : null;
}
