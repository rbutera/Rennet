/**
 * The GitHub OAuth device flow + token refresh (v4.2/v4.3 — the gh-CLI
 * piggyback's replacement, now expiration-aware).
 *
 * A public OAuth App client: the client id is a public identifier (safe to
 * commit), there is no client secret and no Rennet backend — every call goes
 * straight to github.com's login endpoints from the user's own machine. GitHub
 * documents that device-flow-minted tokens refresh with the client id ALONE, so
 * expiring-token app configurations work without ever holding a secret.
 *
 * Two flows live here:
 *  • `runGitHubDeviceFlow` — mint a device code (`POST /login/device/code`),
 *    surface the one-time user code, poll `POST /login/oauth/access_token`
 *    until the user authorizes. Honours GitHub's `interval` and `slow_down`
 *    pacing, and aborts through the injected signal.
 *  • `refreshGitHubCredential` — exchange a refresh token for a fresh pair
 *    (`grant_type=refresh_token`). GitHub ROTATES on use: the old access AND
 *    refresh token die the moment the exchange succeeds, so the caller must
 *    persist the returned pair immediately and never refresh concurrently.
 *
 * Both return the same credential shape. An app with token expiration DISABLED
 * simply returns no `expires_in`/`refresh_token` — the credential carries nulls
 * and the auth ladder never refreshes.
 */

/** The Rennet OAuth App (owner: rbutera). A public identifier, not a secret. */
export const RENNET_GITHUB_CLIENT_ID = "Ov23liDxpY9ZfNnJXYPS";

/**
 * `repo` reads/writes the repositories the user grants; `workflow` lets a push
 * touch `.github/workflows/*` (GitHub rejects such a push without it — a coding
 * agent that cannot push a CI fix is half an agent).
 */
export const RENNET_GITHUB_SCOPES = ["repo", "workflow"];

const LOGIN_BASE = "https://github.com";
/** GitHub's device-flow poll default, seconds; the response's `interval` overrides. */
const DEFAULT_INTERVAL_SECONDS = 5;

/** The device-code verification payload GitHub mints. */
export interface Verification {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

/**
 * THE GitHub credential: the access token plus the expiry/refresh half that an
 * expiring-token app configuration returns. One type end to end — the device
 * flow mints it (filling every field, nulls when expiration is off), the store
 * persists it (a pasted PAT or legacy file is `{ token }` alone), the auth
 * ladder resolves and refreshes it.
 */
export interface GitHubCredential {
  token: string;
  /** ISO timestamp the access token dies at; null/absent for a non-expiring token. */
  expiresAt?: string | null;
  refreshToken?: string | null;
  /** ISO timestamp the refresh token dies at (GitHub: ~6 months); null/absent. */
  refreshTokenExpiresAt?: string | null;
}

/**
 * GitHub declined the exchange at the OAuth level (`access_denied`,
 * `expired_token`, `bad_refresh_token`, …) — re-running the device sign-in is
 * the only recovery. Distinct from a transport failure, which may be retried.
 */
export class GitHubOAuthDeclined extends Error {
  constructor(readonly code: string) {
    super(`GitHub declined the OAuth exchange: ${code}`);
    this.name = "GitHubOAuthDeclined";
  }
}

export interface DeviceFlowOptions {
  /** The outbound HTTP transport (the daemon's fetch). */
  fetch: typeof globalThis.fetch;
  /** Receives the user code + verification URI as soon as GitHub mints them. */
  onVerification: (verification: Verification) => void;
  /** Aborts the poll (user dismissed the connect card). */
  signal?: AbortSignal;
  /** Overrides for tests. */
  clientId?: string;
  scopes?: string[];
  loginBaseUrl?: string;
  now?: () => number;
}

interface TokenExchangeResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  interval?: number;
}

async function postLogin(
  fetch: typeof globalThis.fetch,
  url: string,
  body: Record<string, string>,
  signal?: AbortSignal,
): Promise<TokenExchangeResponse & Verification> {
  const res = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`GitHub login endpoint responded ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as TokenExchangeResponse & Verification;
}

function toCredential(response: TokenExchangeResponse, now: () => number): GitHubCredential {
  if (!response.access_token) {
    throw new Error("GitHub token exchange returned no access_token");
  }
  const at = (seconds: number | undefined): string | null =>
    seconds === undefined ? null : new Date(now() + seconds * 1000).toISOString();
  return {
    token: response.access_token,
    expiresAt: at(response.expires_in),
    refreshToken: response.refresh_token ?? null,
    refreshTokenExpiresAt: at(response.refresh_token_expires_in),
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("GitHub connect was cancelled"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error("GitHub connect was cancelled"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Run the device flow to completion; resolves with the minted credential. */
export async function runGitHubDeviceFlow(options: DeviceFlowOptions): Promise<GitHubCredential> {
  const base = options.loginBaseUrl ?? LOGIN_BASE;
  const clientId = options.clientId ?? RENNET_GITHUB_CLIENT_ID;
  const now = options.now ?? Date.now;
  const { fetch, signal } = options;

  const verification = await postLogin(
    fetch,
    `${base}/login/device/code`,
    { client_id: clientId, scope: (options.scopes ?? RENNET_GITHUB_SCOPES).join(" ") },
    signal,
  );
  options.onVerification(verification);

  // The device code itself has a lifetime (GitHub: ~15 minutes). GitHub normally
  // answers `expired_token` past it, but a local deadline means a stalled fetch or
  // an endlessly-pending poll can never outlive the code it is polling for.
  const deadline = now() + verification.expires_in * 1000;
  let intervalSeconds = verification.interval || DEFAULT_INTERVAL_SECONDS;
  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new GitHubOAuthDeclined("expired_token");
    await sleep(Math.min(intervalSeconds * 1000, remaining), signal);
    const poll = await postLogin(
      fetch,
      `${base}/login/oauth/access_token`,
      {
        client_id: clientId,
        device_code: verification.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      },
      signal,
    );
    if (poll.access_token) return toCredential(poll, now);
    switch (poll.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        // GitHub's back-pressure: it names the new interval (else +5s per spec).
        intervalSeconds = poll.interval ?? intervalSeconds + 5;
        continue;
      default:
        throw new GitHubOAuthDeclined(poll.error ?? "unknown");
    }
  }
}

export interface RefreshOptions {
  fetch: typeof globalThis.fetch;
  refreshToken: string;
  clientId?: string;
  loginBaseUrl?: string;
  now?: () => number;
}

/**
 * Exchange a refresh token for a fresh credential pair. No client secret: the
 * pair was minted by the device flow, which GitHub refreshes on client id
 * alone. Throws `GitHubOAuthDeclined` when GitHub rejects the refresh token
 * (expired, already rotated, revoked) — the sign-in must be re-run.
 */
export async function refreshGitHubCredential(options: RefreshOptions): Promise<GitHubCredential> {
  const base = options.loginBaseUrl ?? LOGIN_BASE;
  const response = await postLogin(options.fetch, `${base}/login/oauth/access_token`, {
    client_id: options.clientId ?? RENNET_GITHUB_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: options.refreshToken,
  });
  if (!response.access_token) {
    throw new GitHubOAuthDeclined(response.error ?? "unknown");
  }
  return toCredential(response, options.now ?? Date.now);
}
