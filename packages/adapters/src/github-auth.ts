import type { Octokit } from "@octokit/core";
import type { SsoState } from "@rennet/core";
import { headerGet, requestErrorStatus } from "./github-octokit";
import { parseGitHubSso } from "./github-sso";

/**
 * GitHub auth resolution over the STORED token (the gh-CLI rung is gone — v4.2).
 *
 * One token, one store: the daemon's `SecretStore` holds a single GitHub token,
 * minted either by the OAuth device flow (`github-device-flow.ts`) or pasted as
 * a personal access token — the side door. Resolution reads the stored token and
 * validates it with `GET /rate_limit`, reading `X-OAuth-Scopes` (scope check),
 * `Github-Authentication-Token-Expiration` (expiry), and `X-RateLimit-Limit`
 * (poll budget). Four DISTINCT failure states, each with its own copy, so the
 * UI renders them as different problems, not one "GitHub unavailable".
 */

/**
 * The host token vault. One GitHub token, whether minted by the device flow or
 * pasted; `null` clears it (disconnect). The token never reaches the renderer.
 */
export interface SecretStore {
  getGitHubToken(): Promise<string | null>;
  setGitHubToken(token: string | null): Promise<void>;
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
  secretStore: Pick<SecretStore, "getGitHubToken">;
  /** The scope the selected operation needs. Defaults to classic `repo`. */
  requiredScope?: string;
}

const COPY = {
  notConnected:
    "GitHub is not connected. Connect with a one-time device sign-in, or paste a personal access token.",
  tokenInvalid:
    "The stored GitHub token was revoked or has expired. Reconnect, or paste a fresh personal access token.",
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
  deps: ResolveAuthDeps,
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

/**
 * Resolve GitHub auth from the stored token (device-flow-minted or pasted PAT —
 * same store, same treatment). No stored token is the honest `not-connected`
 * state; a stored token is validated via `/rate_limit` on every resolution.
 */
export async function resolveGitHubAuth(deps: ResolveAuthDeps): Promise<GitHubAuthState> {
  const stored = await deps.secretStore.getGitHubToken();
  if (!stored || stored.length === 0) {
    return { ok: false, reason: "not-connected", copy: COPY.notConnected };
  }
  return validateGitHubToken(stored, deps);
}
