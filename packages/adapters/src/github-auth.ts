import type { Octokit } from "@octokit/core";
import type { SsoState } from "@rennet/core";
import { type GitHubCredential, GitHubOAuthDeclined } from "./github-device-flow";
import { isGitHubNetworkError } from "./github-fetch";
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
 * The failure states are DISTINCT — not-connected, token-invalid,
 * insufficient-scope, network — each with its own copy, so the UI renders them
 * as different problems, not one "GitHub unavailable". A network failure is
 * NEVER token-invalid: an unreachable GitHub says nothing about the token, and
 * resolution degrades honestly instead of throwing raw transport errors.
 */

/** The host credential vault. `null` clears it (disconnect); the token never
 * reaches the renderer. */
export interface SecretStore {
  getGitHubCredential(): Promise<GitHubCredential | null>;
  setGitHubCredential(credential: GitHubCredential | null): Promise<void>;
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
  | { ok: false; reason: "insufficient-scope"; copy: string; scopes: string[] }
  | { ok: false; reason: "network"; copy: string };

/**
 * A single refresh-exchange observation, secret-free BY CONSTRUCTION: there is no
 * field that can hold a token, refresh token, or client secret, so a credential
 * cannot be logged even by mistake. `create-server` serializes it to one
 * `[github-auth]` line in `daemon.log`, so a field failure is observed, not inferred.
 */
export interface RefreshLogRecord {
  phase: "attempt" | "persisted" | "declined" | "network";
  /** The verbatim GitHub `error` code on a decline (e.g. `bad_refresh_token`). */
  githubError?: string;
  /** A non-secret token-kind label (`ghu_`/`gho_`/…), never the token body. */
  tokenKind?: string;
}

/**
 * GitHub credential prefixes, a CLOSED allowlist. `tokenKind` returns ONLY one of
 * these constants (or the fixed `"token"`), never a slice of the token — so an
 * unexpected value like `customerSecret_x` can never put credential bytes in a log.
 */
const GITHUB_TOKEN_PREFIXES = [
  "github_pat_",
  "ghu_",
  "gho_",
  "ghp_",
  "ghr_",
  "ghs_",
  "ghe_",
] as const;

/**
 * The non-secret token-kind label of a GitHub credential — an allowlisted prefix
 * (`ghu_`/`gho_`/…) or the fixed `"token"`. Returns only a constant, never any part
 * of the token body: safe to put in a log record by construction.
 */
export function tokenKind(token: string): string {
  return GITHUB_TOKEN_PREFIXES.find((prefix) => token.startsWith(prefix)) ?? "token";
}

export interface ResolveAuthDeps {
  /** An UNAUTHENTICATED client; the candidate token rides as an explicit header. */
  octokit: Octokit;
  secretStore: SecretStore;
  /** The scope the selected operation needs. Defaults to classic `repo`. */
  requiredScope?: string;
  /**
   * Sink for secret-free refresh observations. Absent ⇒ no-op: callers that do
   * not care about the log need not pass it. `create-server` binds one that
   * writes each record to the daemon's stdout (→ `daemon.log`).
   */
  log?: (record: RefreshLogRecord) => void;
  /**
   * The refresh exchange (`refreshGitHubCredential` bound to the daemon's
   * fetch). Absent ⇒ expiring credentials simply die at expiry (token-invalid).
   */
  refresh?: (refreshToken: string) => Promise<GitHubCredential>;
  /**
   * An exclusive-section runner for the refresh exchange (the daemon's account
   * lock). GitHub ROTATES the refresh token on use, so two concurrent refreshes
   * would kill the session; the credential is RE-READ inside the section, so a
   * caller that lost the race adopts the winner's rotation instead of burning
   * the already-dead refresh token. Validation runs OUTSIDE it — a hung GitHub
   * request must never block a disconnect. Defaults to no exclusion.
   */
  withLock?: <T>(section: () => Promise<T>) => Promise<T>;
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
  network:
    "GitHub is unreachable right now — showing local work only. Your connection and token are untouched.",
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
    // An unreachable GitHub (timeout, DNS, refused connection) is the NETWORK's
    // failure, never the token's — mislabeling it token-invalid would prompt the
    // user to disconnect a perfectly fine token.
    if (isGitHubNetworkError(error)) {
      return { ok: false, reason: "network", copy: COPY.network };
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
function nearExpiry(credential: GitHubCredential, now: number): boolean {
  if (!credential.expiresAt) return false;
  const expiresAt = Date.parse(credential.expiresAt);
  // A malformed expiry reads as ALREADY EXPIRED, not as non-expiring: refreshing
  // self-heals the corrupt field, while skipping would silently disable renewal.
  if (Number.isNaN(expiresAt)) return true;
  return expiresAt - now < REFRESH_SKEW_MS;
}

/** The one declined-refresh outcome (proactive and reactive branches share it). */
function refreshDeclinedState(): GitHubAuthState {
  return { ok: false, reason: "token-invalid", copy: COPY.refreshDeclined };
}

/**
 * Run the refresh exchange inside the exclusive section and PERSIST the rotated
 * pair (GitHub kills the old access and refresh token on success, so persistence
 * is not optional). The stored credential is RE-READ inside the section: when a
 * concurrent resolution already rotated, ITS fresh pair is adopted instead of
 * burning a refresh token that is already dead. Returns null when GitHub
 * declines — the sign-in must be re-run; transport errors propagate so a
 * network blip never reads as a dead session.
 */
async function refreshAndPersist(
  expected: GitHubCredential,
  deps: ResolveAuthDeps,
): Promise<GitHubCredential | null> {
  const refresh = deps.refresh;
  if (!refresh) return null;
  const log: (record: RefreshLogRecord) => void = deps.log ?? (() => undefined);
  const exclusively = deps.withLock ?? (<T>(section: () => Promise<T>) => section());
  return exclusively(async () => {
    const current = await deps.secretStore.getGitHubCredential();
    if (!current) return null; // disconnected while we waited for the lock
    if (current.token !== expected.token) return current; // another caller rotated
    if (!current.refreshToken) return null;
    // Emitted at the START of the exchange (both proactive and reactive branches
    // route through here) so an attempt is visible in daemon.log even if the
    // process dies mid-exchange.
    log({ phase: "attempt" });
    let minted: GitHubCredential;
    try {
      minted = await refresh(current.refreshToken);
    } catch (error) {
      // A decline is deterministic — name its cause; the surface resolves token-invalid.
      if (error instanceof GitHubOAuthDeclined) {
        log({ phase: "declined", githubError: error.code });
        return null;
      }
      // NO retry here. The shared GitHub transport (`withConnectResilience`) already
      // retries a CONNECT-PHASE blip exactly once — provably replay-safe, since no
      // request reached GitHub — and deliberately never replays a post-send failure,
      // which could double a rotation. A second retry at this layer would duplicate
      // connect attempts AND risk burning a rotated refresh token on an ambiguous
      // post-send error. So observe the network failure and propagate it:
      // resolveGitHubAuth classifies it `network` and leaves the credential untouched.
      if (isGitHubNetworkError(error)) log({ phase: "network" });
      throw error;
    }
    await deps.secretStore.setGitHubCredential(minted);
    log({ phase: "persisted", tokenKind: tokenKind(minted.token) });
    return minted;
  });
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

  let credential: GitHubCredential = stored;
  let refreshed = false;
  // Proactive: renew before GitHub starts rejecting, so no request ever fails.
  if (deps.refresh && stored.refreshToken && nearExpiry(stored, now)) {
    let next: GitHubCredential | null;
    try {
      next = await refreshAndPersist(stored, deps);
    } catch (error) {
      // A transport blip during the refresh POST is the NETWORK's failure: the
      // stored pair is untouched (GitHub only rotates on success), so degrade
      // honestly instead of throwing raw or reading it as a dead session.
      if (isGitHubNetworkError(error)) {
        return { ok: false, reason: "network", copy: COPY.network };
      }
      throw error;
    }
    if (next === null) return refreshDeclinedState();
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
    let next: GitHubCredential | null;
    try {
      next = await refreshAndPersist(stored, deps);
    } catch (error) {
      // Same honesty as the proactive branch: an unreachable GitHub during the
      // reactive refresh never invalidates the session.
      if (isGitHubNetworkError(error)) {
        return { ok: false, reason: "network", copy: COPY.network };
      }
      throw error;
    }
    if (next === null) return refreshDeclinedState();
    return validateGitHubToken(next.token, deps);
  }
  return state;
}
