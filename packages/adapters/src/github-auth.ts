import type { SsoState } from "@rennet/core";
import { parseGitHubSso } from "./github-sso";

/**
 * The GitHub auth ladder, rungs 0 and 2 (GitHub Integration Plan §1).
 *
 * Rung 0 shells out to `gh auth token` — NEVER parsing `hosts.yml`, because a
 * machine can have an env-selected credential and a stored credential at once
 * with different scopes, and `gh` may use the system keyring instead of the file.
 * Rung 2 is a pasted PAT read from the host secret store. Either token is then
 * validated with `GET /rate_limit`, reading `X-OAuth-Scopes` (scope check),
 * `Github-Authentication-Token-Expiration` (expiry), and `X-RateLimit-Limit`
 * (poll budget). Three DISTINCT failure states, each with its own copy, so the
 * future UI renders them as three different problems, not one "GitHub
 * unavailable". The rung-0 token is never persisted — this module holds no write
 * path to the secret store, so it structurally cannot store it.
 */

/** A minimal HTTP response (the injected `fetch` returns this shape). */
export interface HttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type HttpFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<HttpResponse>;

/** Runs `gh auth token`. Rejects (ENOENT) when `gh` is absent; exit≠0 when logged out. */
export type GhRunner = () => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/** The host token vault (Electron `safeStorage` in production). Read-only here. */
export interface SecretStore {
  getGitHubToken(): Promise<string | null>;
}

/** The rung a token came from. */
export type AuthRung = "gh" | "pat";

/**
 * The auth outcome. The success variant carries the token for the adapter's
 * in-memory use ONLY — it is host-side and never projected to the renderer. The
 * three failure variants are renderer-safe and each carry their own copy.
 */
export type GitHubAuthState =
  | {
      ok: true;
      rung: AuthRung;
      token: string;
      scopes: string[];
      expiresAt: string | null;
      rateLimit: number | null;
      sso: SsoState;
    }
  | { ok: false; reason: "gh-absent"; copy: string }
  | { ok: false; reason: "gh-not-logged-in"; copy: string }
  | { ok: false; reason: "insufficient-scope"; copy: string; scopes: string[] };

export interface ResolveAuthDeps {
  gh: GhRunner;
  http: HttpFetch;
  secretStore: SecretStore;
  /** The scope the selected operation needs. Defaults to classic `repo`. */
  requiredScope?: string;
  /** The rate-limit endpoint. Defaults to public github.com. */
  rateLimitUrl?: string;
}

const RATE_LIMIT_URL = "https://api.github.com/rate_limit";

const COPY = {
  ghAbsent:
    "GitHub CLI (`gh`) was not found. Install it and run `gh auth login`, or paste a personal access token below.",
  ghNotLoggedIn:
    "`gh` is installed but not logged in. Run `gh auth login`, or paste a personal access token below.",
  insufficientScope:
    "This token is missing the `repo` scope needed to read pull requests. Re-authorize with `repo`, or paste a token that has it.",
} as const;

function parseScopes(header: string | null): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}

/** Validate a token against `/rate_limit`; returns the ok state or an insufficient-scope failure. */
async function validate(
  token: string,
  rung: AuthRung,
  deps: ResolveAuthDeps,
): Promise<GitHubAuthState> {
  const requiredScope = deps.requiredScope ?? "repo";
  const url = deps.rateLimitUrl ?? RATE_LIMIT_URL;
  const res = await deps.http(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  const scopes = parseScopes(res.headers.get("X-OAuth-Scopes"));
  const sso = parseGitHubSso(res.headers.get("X-GitHub-SSO"));
  if (!scopes.includes(requiredScope)) {
    return { ok: false, reason: "insufficient-scope", copy: COPY.insufficientScope, scopes };
  }
  const rateLimitHeader = res.headers.get("X-RateLimit-Limit");
  const rateLimit = rateLimitHeader ? Number(rateLimitHeader) : null;
  return {
    ok: true,
    rung,
    token,
    scopes,
    expiresAt: res.headers.get("Github-Authentication-Token-Expiration"),
    rateLimit: Number.isNaN(rateLimit) ? null : rateLimit,
    sso,
  };
}

/**
 * Resolve GitHub auth: try rung 0 (`gh auth token`); on gh-absent or logged-out,
 * fall back to a pasted PAT (rung 2) if one is stored; otherwise return the
 * distinct gh failure state. A token, once obtained by either rung, is validated
 * via `/rate_limit`.
 */
export async function resolveGitHubAuth(deps: ResolveAuthDeps): Promise<GitHubAuthState> {
  let ghToken: string | null = null;
  let ghFailure: "gh-absent" | "gh-not-logged-in" | null = null;
  try {
    const result = await deps.gh();
    const token = result.stdout.trim();
    if (result.exitCode === 0 && token.length > 0) {
      ghToken = token;
    } else {
      ghFailure = "gh-not-logged-in";
    }
  } catch {
    // A spawn failure (ENOENT and friends) means `gh` is not installed.
    ghFailure = "gh-absent";
  }

  if (ghToken) return validate(ghToken, "gh", deps);

  // Rung 2: a pasted PAT is the escape hatch when `gh` cannot answer.
  const pasted = await deps.secretStore.getGitHubToken();
  if (pasted && pasted.length > 0) return validate(pasted, "pat", deps);

  return ghFailure === "gh-absent"
    ? { ok: false, reason: "gh-absent", copy: COPY.ghAbsent }
    : { ok: false, reason: "gh-not-logged-in", copy: COPY.ghNotLoggedIn };
}
