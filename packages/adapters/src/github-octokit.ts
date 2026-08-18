import { Octokit } from "@octokit/core";

/**
 * The one place a GitHub `Octokit` client is constructed (v4.2 — the octokit
 * migration). Every GitHub adapter takes an injected `Octokit`, so no test
 * touches the network (inject a fake `fetch`) and no adapter constructs its own
 * transport. No retry/throttle plugins: the publish path owns its rate-limit
 * semantics (`ForgeRateLimited`, backoff on GitHub's schedule — never a hidden
 * retry storm), so the client stays the plugin-free `@octokit/core`.
 */

export interface GitHubOctokitOptions {
  /** The outbound HTTP transport (the daemon's fetch; a fake in tests). */
  fetch: typeof globalThis.fetch;
  /** The bearer for authenticated calls; omitted for the pre-auth device flow. */
  token?: string;
  /** Overrides api.github.com (tests, GitHub Enterprise someday). */
  baseUrl?: string;
}

export function createGitHubOctokit(options: GitHubOctokitOptions): Octokit {
  return new Octokit({
    request: { fetch: options.fetch },
    ...(options.token === undefined ? {} : { auth: options.token }),
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
  });
}

/** Octokit lower-cases response headers into a plain object; normalise to string|null. */
export function headerGet(
  headers: Record<string, string | number | undefined>,
  name: string,
): string | null {
  const value = headers[name.toLowerCase()];
  return value === undefined ? null : String(value);
}

/** The status of a thrown Octokit `RequestError`, or null for a non-HTTP failure. */
export function requestErrorStatus(error: unknown): number | null {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status: unknown }).status;
    if (typeof status === "number") return status;
  }
  return null;
}

/** The response headers of a thrown Octokit `RequestError` (empty when absent). */
export function requestErrorHeaders(error: unknown): Record<string, string | number | undefined> {
  if (typeof error === "object" && error !== null && "response" in error) {
    const response = (error as { response?: { headers?: Record<string, string> } }).response;
    if (response?.headers) return response.headers;
  }
  return {};
}
