import type { GitHubAuthStatus } from "@rennet/protocol";
import { Button, Input, toast } from "@rennet/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useCommand, useMutation } from "../data";
import { messageFrom } from "../lib/message-from";
import { GitHubIcon } from "./brand-mark";

/** Transient "you're connected" confirmation — the persistent status row/card is the durable truth. */
function announceConnected(status: GitHubAuthStatus): void {
  const login = status.state === "connected" ? status.login : null;
  toast.add({
    title: login ? `Connected to GitHub as @${login}` : "Connected to GitHub",
    type: "success",
  });
}

function isGitHubCliOwned(status: GitHubAuthStatus | null): boolean {
  return status !== null && status.state !== "not-connected" && status.source === "gh";
}

/**
 * The GitHub account surfaces (v4.2 — wireframes 01 + 15): the SKIPPABLE
 * first-run connect card and the settings account rows, sharing one device-flow
 * hook. The user's authenticated GitHub CLI is primary. OAuth device sign-in
 * (code shown here, entered at github.com/login/device) and a pasted token are
 * explicit fallbacks. The token itself never reaches this layer — only the
 * renderer-safe status projection, including which side owns the credential.
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

/** Every write here changes the stored account, so each one stales the status read.
 *  Module-level so the mutation callbacks keep a stable identity across renders. */
const STALES_STATUS = { invalidates: ["github.status"] } as const;

/** Load + expose the account status, the device flow, and the paste side door. */
export function useGitHubAccount() {
  // The account status is a SEAM read, not local state: ONE cache entry that every
  // GitHub surface shares. Removing a Rennet-managed fallback from Settings stales it,
  // so every mounted surface re-reads instead of rendering a credential that is gone.
  // A `gh` credential has no Rennet-side disconnect; its lifecycle stays with the CLI.
  const { data, error: statusError } = useCommand("github.status", {});
  const status = data?.status ?? null;
  const { mutate: startFlow } = useMutation("github.connectStart");
  // The poll stales the status on every tick, which is the point: it IS the "has this
  // account changed yet" question, and a sign-in completed out of band lands the same way.
  const { mutate: pollFlow } = useMutation("github.connectPoll", STALES_STATUS);
  const { mutate: cancelFlow } = useMutation("github.connectCancel");
  const { mutate: runDisconnect } = useMutation("github.disconnect", STALES_STATUS);
  const { mutate: storeToken } = useMutation("github.setToken", STALES_STATUS);
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

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current += 1;
      stopPolling();
    };
  }, [stopPolling]);

  const connect = useCallback(async () => {
    setError(undefined);
    const started = generation.current;
    try {
      const flowStart = await startFlow({});
      if (!alive.current || generation.current !== started) return;
      setFlow({ userCode: flowStart.userCode, verificationUri: flowStart.verificationUri });
      stopPolling();
      pollTimer.current = setInterval(() => {
        void pollFlow({})
          .then(({ poll }) => {
            if (!alive.current || generation.current !== started) return stopPolling();
            if (poll.phase === "pending") return;
            stopPolling();
            setFlow(null);
            // The poll already staled the status read, so the connected account arrives
            // through the seam; the returned status is only the toast's subject.
            if (poll.phase === "connected") announceConnected(poll.status);
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
  }, [startFlow, pollFlow, stopPolling]);

  const cancel = useCallback(async () => {
    generation.current += 1;
    stopPolling();
    setFlow(null);
    await cancelFlow({}).catch(() => undefined);
  }, [cancelFlow, stopPolling]);

  const disconnect = useCallback(async () => {
    setError(undefined);
    try {
      await runDisconnect({});
    } catch (reason) {
      setError(messageFrom(reason));
    }
  }, [runDisconnect]);

  const pasteToken = useCallback(
    async (token: string) => {
      setError(undefined);
      try {
        // Accepted or rejected, this staled the status read — so the row always shows the
        // REAL stored account. A connected user who mistypes a replacement sees the copy
        // for the failed candidate, never their live account rendered as broken.
        const { status: next } = await storeToken({ token });
        if (next.state === "connected") {
          if (alive.current) announceConnected(next);
          return true;
        }
        if (alive.current) setError(next.copy);
        return false;
      } catch (reason) {
        if (alive.current) setError(messageFrom(reason));
        return false;
      }
    },
    [storeToken],
  );

  return { status, statusError, flow, error, connect, cancel, disconnect, pasteToken };
}

/** The in-flight device flow: the one-time code and where to enter it. */
export function DeviceFlowPrompt({ flow, onCancel }: { flow: DeviceFlow; onCancel(): void }) {
  return (
    <div className="github-flow flex items-center gap-3 min-w-0 flex-1">
      <span className="github-code font-mono text-lg font-bold tracking-[0.12em] px-2.5 py-1.5 rounded-control border border-line-strong bg-raised text-ink whitespace-nowrap">
        {flow.userCode}
      </span>
      <span className="github-flow-hint text-sm text-ink-faint min-w-0 [&_a]:text-inherit [&_a]:underline">
        Enter this code at{" "}
        <a href={flow.verificationUri} target="_blank" rel="noreferrer">
          {flow.verificationUri.replace(/^https:\/\//, "")}
        </a>
        {" · waiting for GitHub…"}
      </span>
      <Button variant="outline" className="github-btn" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

/**
 * The first-run connect card (wireframe 01): skippable, never a wall. Renders
 * nothing when connected, dismissed on this machine, or status is unknown.
 */
export function GitHubConnectCard() {
  const account = useGitHubAccount();
  const [dismissed, setDismissed] = useState(() => readDismissed());
  const ghOwned = isGitHubCliOwned(account.status);

  // "network" hides the card too: GitHub being unreachable says nothing about
  // whether an account is connected, and a connect attempt cannot succeed offline.
  // Settings still shows the honest unreachable copy.
  if (
    dismissed ||
    !account.status?.state ||
    account.status.state === "connected" ||
    account.status.state === "network" ||
    ghOwned
  ) {
    return null;
  }

  return (
    <aside className="github-card flex items-center gap-3 self-center w-[min(560px,100%)] mt-3.5 px-4 py-3 rounded-surface border border-line bg-surface text-base">
      <span className="github-card-icon inline-flex text-ink" aria-hidden="true">
        <GitHubIcon className="size-4.5" />
      </span>
      {account.flow ? (
        <DeviceFlowPrompt flow={account.flow} onCancel={() => void account.cancel()} />
      ) : (
        <>
          <span className="github-card-main flex flex-col gap-0.5 min-w-0">
            <span className="github-card-title font-semibold text-ink">GitHub fallback</span>
            <span className="github-card-sub text-sm text-ink-faint">
              Use device sign-in only when GitHub CLI isn't available here.
            </span>
          </span>
          <Button
            variant="ghost"
            className="github-skip ml-auto text-ink-faint"
            onClick={() => {
              writeDismissed();
              setDismissed(true);
            }}
          >
            Skip for now
          </Button>
          <Button variant="outline" className="github-btn" onClick={() => void account.connect()}>
            Use fallback
          </Button>
        </>
      )}
      {account.error ? (
        <span className="github-error text-sm text-ink mt-2">{account.error}</span>
      ) : null}
    </aside>
  );
}

/** The settings account rows (wireframe 15): credential owner as fact, then its real actions. */
export function GitHubAccountRows() {
  const account = useGitHubAccount();
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
  if (status === null) {
    return (
      <div className="settings-row flex items-center gap-3.5 py-3.5">
        <div className="settings-row-label flex flex-col gap-0.5">
          <span className="settings-k text-base font-semibold text-ink">GitHub account</span>
          <span className="settings-d text-base text-ink-faint">
            Credential source must resolve before fallback actions appear.
          </span>
        </div>
        <span className="github-problem ml-auto max-w-[340px] text-sm text-ink-faint">
          {account.statusError
            ? `Couldn't read GitHub credential status: ${messageFrom(account.statusError)}`
            : "Checking GitHub credential source…"}
        </span>
      </div>
    );
  }
  const connected = status?.state === "connected" ? status : null;
  const ghOwned = isGitHubCliOwned(status);
  const fallbackActionsAvailable = !ghOwned && status.state !== "network";
  return (
    <>
      <div className="settings-row flex items-center gap-3.5 py-3.5">
        <div className="settings-row-label flex flex-col gap-0.5">
          <span className="settings-k text-base font-semibold text-ink">
            {ghOwned ? "GitHub CLI" : "GitHub fallback"}
          </span>
          <span className="settings-d text-base text-ink-faint">
            {ghOwned
              ? "credential managed by gh · run gh auth logout to disconnect"
              : "Rennet-managed device sign-in or access token"}
          </span>
        </div>
        <div className="settings-row-value github-row-value ml-auto flex items-center gap-2.5">
          {account.flow && !ghOwned ? (
            <DeviceFlowPrompt flow={account.flow} onCancel={() => void account.cancel()} />
          ) : connected ? (
            <>
              <span className="github-connected inline-flex items-center gap-1.5 font-mono text-sm font-semibold text-ink whitespace-nowrap">
                <GitHubIcon className="size-3.5" />
                connected{connected.login ? ` · @${connected.login}` : ""}
              </span>
              {connected.source === "fallback" ? (
                <Button
                  variant="outline"
                  className="github-btn"
                  onClick={() => void account.disconnect()}
                >
                  Disconnect
                </Button>
              ) : null}
            </>
          ) : (
            <>
              {status && "copy" in status ? (
                <span className="github-problem text-sm text-ink max-w-[340px]">{status.copy}</span>
              ) : (
                <span className="github-problem faint text-sm text-ink-faint max-w-[340px]">
                  not connected
                </span>
              )}
              {fallbackActionsAvailable ? (
                <Button
                  variant="outline"
                  className="github-btn"
                  onClick={() => void account.connect()}
                >
                  Use fallback sign-in
                </Button>
              ) : null}
            </>
          )}
        </div>
      </div>
      {fallbackActionsAvailable ? (
        <div className="settings-row flex items-center gap-3.5 py-3.5">
          <div className="settings-row-label flex flex-col gap-0.5">
            <span className="settings-k text-base font-semibold text-ink">
              Fallback access token
            </span>
            <span className="settings-d text-base text-ink-faint">
              Paste a token only when GitHub CLI isn't available here.
            </span>
          </div>
          <div className="settings-row-value github-row-value ml-auto flex items-center gap-2.5">
            <Input
              className="github-token-input w-[220px] font-mono"
              type="password"
              placeholder="Paste token…"
              value={token}
              aria-label="GitHub fallback access token"
              onChange={(event) => setToken(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void paste();
              }}
            />
            <Button
              variant="outline"
              className="github-btn"
              disabled={token.trim().length === 0 || saving}
              onClick={() => void paste()}
            >
              Save
            </Button>
          </div>
        </div>
      ) : null}
      {account.error ? (
        <p className="github-error py-2.5 text-sm text-ink">{account.error}</p>
      ) : null}
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
