import type { GitHubAuthStatus, RennetBridge } from "@rennet/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { messageFrom } from "../lib/message-from";
import { GitHubIcon } from "./icons";

/**
 * The GitHub account surfaces (v4.2 — wireframes 01 + 15): the SKIPPABLE
 * first-run connect card and the settings account rows, sharing one device-flow
 * hook. GitHub is an account, not a CLI: one OAuth device sign-in (code shown
 * here, entered at github.com/login/device), a pasted token as the side door,
 * and honest per-problem copy from the host. The token itself never reaches this
 * layer — only the renderer-safe status projection.
 *
 * The card is a card, not a wall: working-tree review needs no GitHub, so it is
 * dismissible (remembered per machine) and every GitHub-needing surface asks
 * again lazily at its own point of need. The permanent home is Settings.
 */

const DISMISS_KEY = "rennet.github-card-dismissed";
const POLL_MS = 2000;

interface DeviceFlow {
  userCode: string;
  verificationUri: string;
}

/** Load + expose the account status, the device flow, and the paste side door. */
export function useGitHubAccount(bridge: RennetBridge) {
  const [status, setStatus] = useState<GitHubAuthStatus | null>(null);
  const [flow, setFlow] = useState<DeviceFlow | null>(null);
  const [error, setError] = useState<string>();
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  // Continuation guard: unmount or cancel bumps the generation, so a bridge call
  // that settles late neither sets state nor installs a fresh interval.
  const generation = useRef(0);
  const alive = useRef(true);

  const stopPolling = useCallback(() => {
    if (pollTimer.current !== null) clearInterval(pollTimer.current);
    pollTimer.current = null;
  }, []);

  const refresh = useCallback(async () => {
    try {
      const { status: loaded } = await bridge.invoke("github.status", {});
      if (alive.current) setStatus(loaded);
    } catch {
      if (alive.current) setStatus(null);
    }
  }, [bridge]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
      generation.current += 1;
      stopPolling();
    };
  }, [refresh, stopPolling]);

  const connect = useCallback(async () => {
    setError(undefined);
    const started = generation.current;
    try {
      const flowStart = await bridge.invoke("github.connectStart", {});
      if (!alive.current || generation.current !== started) return;
      setFlow({ userCode: flowStart.userCode, verificationUri: flowStart.verificationUri });
      stopPolling();
      pollTimer.current = setInterval(() => {
        void bridge
          .invoke("github.connectPoll", {})
          .then(({ poll }) => {
            if (!alive.current || generation.current !== started) return stopPolling();
            if (poll.phase === "pending") return;
            stopPolling();
            setFlow(null);
            if (poll.phase === "connected") setStatus(poll.status);
            else if (poll.phase === "failed") setError(poll.message);
            // "idle" mid-flow means the daemon lost the flow (restart): the code
            // the user is holding is dead — say so, never just vanish the prompt.
            else setError("The sign-in was interrupted. Start again.");
          })
          .catch(() => {
            /* a dropped poll retries on the next tick */
          });
      }, POLL_MS);
    } catch (reason) {
      if (alive.current && generation.current === started) setError(messageFrom(reason));
    }
  }, [bridge, stopPolling]);

  const cancel = useCallback(async () => {
    generation.current += 1;
    stopPolling();
    setFlow(null);
    await bridge.invoke("github.connectCancel", {}).catch(() => undefined);
  }, [bridge, stopPolling]);

  const disconnect = useCallback(async () => {
    setError(undefined);
    try {
      await bridge.invoke("github.disconnect", {});
      await refresh();
    } catch (reason) {
      setError(messageFrom(reason));
    }
  }, [bridge, refresh]);

  const pasteToken = useCallback(
    async (token: string) => {
      setError(undefined);
      try {
        const { status: next } = await bridge.invoke("github.setToken", { token });
        if (next.state === "connected") {
          if (alive.current) setStatus(next);
          return true;
        }
        // A REJECTED paste is the candidate's failure, not the account's: surface
        // the copy but re-read the real stored-account status, so a connected user
        // who mistypes a replacement never sees their live account as broken.
        if (alive.current) setError(next.copy);
        await refresh();
        return false;
      } catch (reason) {
        if (alive.current) setError(messageFrom(reason));
        return false;
      }
    },
    [bridge, refresh],
  );

  return { status, flow, error, connect, cancel, disconnect, pasteToken };
}

/** The in-flight device flow: the one-time code and where to enter it. */
function DeviceFlowPrompt({ flow, onCancel }: { flow: DeviceFlow; onCancel(): void }) {
  return (
    <div className="github-flow">
      <span className="github-code">{flow.userCode}</span>
      <span className="github-flow-hint">
        Enter this code at{" "}
        <a href={flow.verificationUri} target="_blank" rel="noreferrer">
          {flow.verificationUri.replace(/^https:\/\//, "")}
        </a>
        {" · waiting for GitHub…"}
      </span>
      <button type="button" className="github-btn" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

/**
 * The first-run connect card (wireframe 01): skippable, never a wall. Renders
 * nothing when connected, dismissed on this machine, or status is unknown.
 */
export function GitHubConnectCard({ bridge }: { bridge: RennetBridge }) {
  const account = useGitHubAccount(bridge);
  const [dismissed, setDismissed] = useState(() => readDismissed());

  // "network" hides the card too: GitHub being unreachable says nothing about
  // whether an account is connected, and a connect attempt cannot succeed offline.
  // Settings still shows the honest unreachable copy.
  if (
    dismissed ||
    !account.status?.state ||
    account.status.state === "connected" ||
    account.status.state === "network"
  ) {
    return null;
  }

  return (
    <aside className="github-card">
      <span className="github-card-icon" aria-hidden="true">
        <GitHubIcon size={18} />
      </span>
      {account.flow ? (
        <DeviceFlowPrompt flow={account.flow} onCancel={() => void account.cancel()} />
      ) : (
        <>
          <span className="github-card-main">
            <span className="github-card-title">Connect GitHub</span>
            <span className="github-card-sub">
              One-time device sign-in. Only needed when a review touches GitHub.
            </span>
          </span>
          <button
            type="button"
            className="github-skip"
            onClick={() => {
              writeDismissed();
              setDismissed(true);
            }}
          >
            Skip for now
          </button>
          <button type="button" className="github-btn" onClick={() => void account.connect()}>
            Connect
          </button>
        </>
      )}
      {account.error ? <span className="github-error">{account.error}</span> : null}
    </aside>
  );
}

/** The settings account rows (wireframe 15): status as fact, connect, paste, disconnect. */
export function GitHubAccountRows({ bridge }: { bridge: RennetBridge }) {
  const account = useGitHubAccount(bridge);
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);

  async function paste(): Promise<void> {
    if (token.trim().length === 0 || saving) return;
    setSaving(true);
    const stored = await account.pasteToken(token.trim());
    if (stored) setToken("");
    setSaving(false);
  }

  const status = account.status;
  return (
    <>
      <div className="settings-row">
        <div className="settings-row-label">
          <span className="settings-k">GitHub</span>
          <span className="settings-d">device sign-in · scopes repo, workflow</span>
        </div>
        <div className="settings-row-value github-row-value">
          {account.flow ? (
            <DeviceFlowPrompt flow={account.flow} onCancel={() => void account.cancel()} />
          ) : status?.state === "connected" ? (
            <>
              <span className="github-connected">
                <GitHubIcon size={14} />
                connected{status.login ? ` · @${status.login}` : ""}
              </span>
              <button
                type="button"
                className="github-btn"
                onClick={() => void account.disconnect()}
              >
                Disconnect
              </button>
            </>
          ) : (
            <>
              {status && status.state !== "not-connected" ? (
                <span className="github-problem">{status.copy}</span>
              ) : (
                <span className="github-problem faint">not connected</span>
              )}
              <button type="button" className="github-btn" onClick={() => void account.connect()}>
                Connect
              </button>
            </>
          )}
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-label">
          <span className="settings-k">Access token</span>
          <span className="settings-d">the side door: paste a token instead of signing in</span>
        </div>
        <div className="settings-row-value github-row-value">
          <input
            className="github-token-input"
            type="password"
            placeholder="Paste token…"
            value={token}
            aria-label="GitHub access token"
            onChange={(event) => setToken(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void paste();
            }}
          />
          <button
            type="button"
            className="github-btn"
            disabled={token.trim().length === 0 || saving}
            onClick={() => void paste()}
          >
            Save
          </button>
        </div>
      </div>
      {account.error ? <p className="github-error">{account.error}</p> : null}
    </>
  );
}

function readDismissed(): boolean {
  try {
    return globalThis.localStorage?.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    globalThis.localStorage?.setItem(DISMISS_KEY, "1");
  } catch {
    /* storage unavailable — the card simply reappears next launch */
  }
}
