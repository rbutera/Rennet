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

export interface ConnectionHostProps {
  /** Build a bridge for a target. MUST be stable (module-level or memoised) — the host keys remounts on it. */
  readonly createBridge: BridgeFactory;
  /** The always-present default (localhost for the desktop, the serving origin for the browser tab). */
  readonly defaultTarget: ConnectionTarget;
  /** localStorage key for the saved remote-daemon list. */
  readonly storageKey?: string;
}

const DEFAULT_STORAGE_KEY = "rennet.daemons";

interface StoredDaemons {
  readonly daemons: readonly ConnectionTarget[];
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
    (t.port === undefined || typeof t.port === "number")
  );
}

/** Read the saved remote daemons. A bad/absent blob degrades to none, no migration ceremony. */
function readStoredDaemons(storageKey: string): readonly ConnectionTarget[] {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StoredDaemons;
    if (!parsed || !Array.isArray(parsed.daemons)) return [];
    return parsed.daemons.filter(isStoredTarget);
  } catch {
    return [];
  }
}

function persistDaemons(storageKey: string, daemons: readonly ConnectionTarget[]): void {
  try {
    globalThis.localStorage?.setItem(
      storageKey,
      JSON.stringify({ daemons } satisfies StoredDaemons),
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
  if (colon === -1) return { host: trimmed };
  const host = trimmed.slice(0, colon);
  const portText = trimmed.slice(colon + 1);
  const port = Number.parseInt(portText, 10);
  if (host.length === 0 || !Number.isInteger(port) || port <= 0 || String(port) !== portText) {
    return null;
  }
  return { host, port };
}

export function ConnectionHost({ createBridge, defaultTarget, storageKey }: ConnectionHostProps) {
  const key = storageKey ?? DEFAULT_STORAGE_KEY;
  const [saved, setSaved] = useState<readonly ConnectionTarget[]>(() => readStoredDaemons(key));
  const [activeId, setActiveId] = useState(defaultTarget.id);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addLabel, setAddLabel] = useState("");
  const [addHost, setAddHost] = useState("");
  const [addCode, setAddCode] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const allTargets = useMemo(() => [defaultTarget, ...saved], [defaultTarget, saved]);
  const activeTarget = allTargets.find((t) => t.id === activeId) ?? defaultTarget;

  // One bridge per active connection; a switch closes the old one and builds the new.
  const bridge = useMemo(() => createBridge(activeTarget), [createBridge, activeTarget]);
  useEffect(() => () => bridge.close?.(), [bridge]);

  const switchTo = useCallback((id: string) => {
    setActiveId(id);
    setSwitcherOpen(false);
  }, []);

  const removeDaemon = useCallback(
    (id: string) => {
      setSaved((current) => {
        const next = current.filter((t) => t.id !== id);
        persistDaemons(key, next);
        return next;
      });
      setActiveId((current) => (current === id ? defaultTarget.id : current));
    },
    [key, defaultTarget.id],
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
    const temp = createBridge({
      id: `pairing:${Date.now()}`,
      label,
      host: parsed.host,
      port: parsed.port,
    });
    try {
      const result = await temp.invoke("pairing.exchange", { code, deviceName: label });
      const target: ConnectionTarget = {
        id: `daemon:${result.deviceId}`,
        label,
        host: parsed.host,
        port: parsed.port,
        deviceToken: result.deviceToken,
      };
      setSaved((current) => {
        const next = [...current.filter((t) => t.id !== target.id), target];
        persistDaemons(key, next);
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
      temp.close?.();
      setAddBusy(false);
    }
  }, [addHost, addCode, addLabel, createBridge, key]);

  return (
    <div className="connection-host">
      <div className="connection-bar">
        <button
          type="button"
          className="connection-indicator"
          onClick={() => setSwitcherOpen((open) => !open)}
          aria-expanded={switcherOpen}
          aria-label={`Connected to ${activeTarget.label}. Switch daemon.`}
        >
          <span className="connection-dot" aria-hidden="true" />
          <span className="connection-name">{activeTarget.label}</span>
        </button>
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
      <RennetApp key={activeId} bridge={bridge} />
    </div>
  );
}
