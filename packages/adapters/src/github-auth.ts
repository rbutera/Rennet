import type { Octokit } from "@octokit/core";
import type { SsoState } from "@rennet/core";
import { type GitHubMintedCredential, GitHubOAuthDeclined } from "./github-device-flow";
import { headerGet, requestErrorStatus } from "./github-octokit";
import { parseGitHubSso } from "./github-sso";

/**
 * GitHub auth resolution over the STORED credential (v4.3 — expiration-aware).
 *
 * One credential, one store: the daemon's `SecretStore` holds a single GitHub
 * credential — minted by the OAuth device flow or pasted as a personal access
 * token (the side door). An app configured with expiring user tokens mints an
 * 8-hour access token plus a rotating refresh token; resolution REFRESHES
 * transparently (shortly before expiry, or reactively on a 401) and persists
 * the rotated pair. A non-expiring configuration carries no refresh half and
 * never refreshes. Validation reads `GET /rate_limit` (`X-OAuth-Scopes` scope
 * gate, expiry header, poll budget) and resolves the login via `GET /user`.
 * The failure states are DISTINCT, each with its own copy, so the UI renders
 * them as different problems, not one "GitHub unavailable".
 */

/**
 * The stored credential: the access token plus the optional expiry/refresh
 * half. A pasted PAT is `{ token }` alone. `null` clears it (disconnect). The
 * token never reaches the renderer.
 */
export interface GitHubStoredCredential {
  token: string;
  expiresAt?: string | null;
  refreshToken?: string | null;
  refreshTokenExpiresAt?: string | null;
}

/** The host credential vault. */
export interface SecretStore {
  getGitHubCredential(): Promise<GitHubStoredCredential | null>;
  setGitHubCredential(credential: GitHubStoredCredential | null): Promise<void>;
}

/**
 * The auth outcome. The success variant carries the token for the adapter's
 * in-memory use ONLY — it is host-side and never projected to the renderer. The
 * failure variants are renderer-safe and each carry their own copy.
 */
export type GitHubAuthState =
  | {
      ok: true;
      token: string;
      login: string | null;
      scopes: string[];
      expiresAt: string | null;
      rateLimit: number | null;
      sso: SsoState;
    }
  | { ok: false; reason: "not-connected"; copy: string }
  | { ok: false; reason: "token-invalid"; copy: string }
  | { ok: false; reason: "insufficient-scope"; copy: string; scopes: string[] };

export interface ResolveAuthDeps {
  /** An UNAUTHENTICATED client; the candidate token rides as an explicit header. */
  octokit: Octokit;
  secretStore: SecretStore;
  /** The scope the selected operation needs. Defaults to classic `repo`. */
  requiredScope?: string;
  /**
   * The refresh exchange (`refreshGitHubCredential` bound to the daemon's
   * fetch). Absent ⇒ expiring credentials simply die at expiry (token-invalid).
   * The CALLER must serialize resolutions: GitHub rotates the refresh token on
   * use, so two concurrent refreshes would kill the session.
   */
  refresh?: (refreshToken: string) => Promise<GitHubMintedCredential>;
  /** The clock, for the near-expiry check. Tests inject; defaults to Date.now. */
  now?: () => number;
}

/** Refresh this long before the access token's stated expiry. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

const COPY = {
  notConnected:
    "GitHub is not connected. Connect with a one-time device sign-in, or paste a personal access token.",
  tokenInvalid:
    "The stored GitHub token was revoked or has expired. Reconnect, or paste a fresh personal access token.",
  refreshDeclined:
    "The GitHub sign-in expired and could not be renewed. Reconnect with the one-time device sign-in.",
  insufficientScope:
    "This token is missing the `repo` scope needed to read pull requests. Reconnect to re-authorize, or paste a token that has it.",
} as const;

function parseScopes(header: string | null): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}

/**
 * Validate a candidate token against `/rate_limit` (and resolve its login via
 * `/user`); returns the ok state or a distinct failure. Exported so the pasted-PAT
 * command can validate BEFORE storing — a bad paste is rejected, never persisted.
 */
export async function validateGitHubToken(
  token: string,
  deps: Pick<ResolveAuthDeps, "octokit" | "requiredScope">,
): Promise<GitHubAuthState> {
  const requiredScope = deps.requiredScope ?? "repo";
  const authHeader = { authorization: `Bearer ${token}` };
  let res: Awaited<ReturnType<Octokit["request"]>>;
  try {
    res = await deps.octokit.request("GET /rate_limit", { headers: authHeader });
  } catch (error) {
    // A revoked or expired token is a 401 — its own problem, never "missing scope".
    if (requestErrorStatus(error) === 401) {
      return { ok: false, reason: "token-invalid", copy: COPY.tokenInvalid };
    }
    throw error;
  }
  const scopesHeader = headerGet(res.headers, "X-OAuth-Scopes");
  const scopes = parseScopes(scopesHeader);
  const sso = parseGitHubSso(headerGet(res.headers, "X-GitHub-SSO"));
  // Fine-grained PATs and GitHub App tokens send NO X-OAuth-Scopes header at all.
  // An ABSENT header is "scopes unknowable", not "no scopes" — the token already
  // proved itself on /rate_limit, so only a PRESENT header missing the required
  // classic scope is an honest insufficient-scope rejection.
  if (scopesHeader !== null && !scopes.includes(requiredScope)) {
    return { ok: false, reason: "insufficient-scope", copy: COPY.insufficientScope, scopes };
  }
  // The signed-in login, for the settings row ("connected · @user"). Best-effort:
  // a failure here never fails auth — the token already validated.
  let login: string | null;
  try {
    const user = await deps.octokit.request("GET /user", { headers: authHeader });
    login = (user.data as { login?: string }).login ?? null;
  } catch {
    login = null;
  }
  const rateLimitHeader = headerGet(res.headers, "X-RateLimit-Limit");
  const rateLimit = rateLimitHeader ? Number(rateLimitHeader) : null;
  return {
    ok: true,
    token,
    login,
    scopes,
    expiresAt: headerGet(res.headers, "Github-Authentication-Token-Expiration"),
    rateLimit: Number.isNaN(rateLimit) ? null : rateLimit,
    sso,
  };
}

/** Whether the access token is dead or dies within the refresh skew. */
function nearExpiry(credential: GitHubStoredCredential, now: number): boolean {
  if (!credential.expiresAt) return false;
  const expiresAt = Date.parse(credential.expiresAt);
  return !Number.isNaN(expiresAt) && expiresAt - now < REFRESH_SKEW_MS;
}

/**
 * Run the refresh exchange and PERSIST the rotated pair (GitHub kills the old
 * access and refresh token on success, so persistence is not optional). Returns
 * null when GitHub declines — the sign-in must be re-run; transport errors
 * propagate so a network blip never reads as a dead session.
 */
async function refreshAndPersist(
  refreshToken: string,
  deps: ResolveAuthDeps,
): Promise<GitHubStoredCredential | null> {
  const refresh = deps.refresh;
  if (!refresh) return null;
  let minted: GitHubMintedCredential;
  try {
    minted = await refresh(refreshToken);
  } catch (error) {
    if (error instanceof GitHubOAuthDeclined) return null;
    throw error;
  }
  await deps.secretStore.setGitHubCredential(minted);
  return minted;
}

/**
 * Resolve GitHub auth from the stored credential (device-flow-minted or pasted
 * PAT — same store, same treatment). No stored credential is the honest
 * `not-connected` state. An expiring credential refreshes shortly BEFORE expiry
 * (and reactively after an unexpected 401), transparently to every caller.
 */
export async function resolveGitHubAuth(deps: ResolveAuthDeps): Promise<GitHubAuthState> {
  const stored = await deps.secretStore.getGitHubCredential();
  if (!stored || stored.token.length === 0) {
    return { ok: false, reason: "not-connected", copy: COPY.notConnected };
  }
  const now = (deps.now ?? Date.now)();

  let credential: GitHubStoredCredential = stored;
  let refreshed = false;
  // Proactive: renew before GitHub starts rejecting, so no request ever fails.
  if (deps.refresh && stored.refreshToken && nearExpiry(stored, now)) {
    const next = await refreshAndPersist(stored.refreshToken, deps);
    if (next === null) {
      return { ok: false, reason: "token-invalid", copy: COPY.refreshDeclined };
    }
    credential = next;
    refreshed = true;
  }

  const state = await validateGitHubToken(credential.token, deps);
  // Reactive: an unexpected 401 (revocation, clock skew past the proactive
  // window) gets ONE refresh attempt before the failure is surfaced.
  if (
    !state.ok &&
    state.reason === "token-invalid" &&
    !refreshed &&
    deps.refresh &&
    stored.refreshToken
  ) {
    const next = await refreshAndPersist(stored.refreshToken, deps);
    if (next === null) {
      return { ok: false, reason: "token-invalid", copy: COPY.refreshDeclined };
    }
    return validateGitHubToken(next.token, deps);
  }
  return state;
}
