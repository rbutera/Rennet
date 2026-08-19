/**
 * The per-request bound on GitHub egress, and the honest name for what a bound
 * request's failure IS (a network problem, not a credential problem).
 *
 * Field bug (lancelot-win, 2026-08-19, broken IPv6): a stalled TCP connection to
 * api.github.com hung `resolveGitHubAuth` forever — a hang never rejects, so the
 * memoized PR resolution never cleared and `project.detail` sat on its loading
 * line permanently. The fix is ONE wrapper at the composition boundary: every
 * request through the GitHub transport gets an abort deadline, so the worst case
 * is a bounded failure that the existing rejection paths already recover from.
 */

/** The deadline for one GitHub request. Generous for a slow link, fatal for a stall. */
export const GITHUB_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Wrap a fetch so every request aborts after `timeoutMs`, composed with any
 * caller-provided signal (the device-flow cancel keeps working; each of its poll
 * requests is individually bounded).
 */
export function withRequestTimeout(
  fetchImpl: typeof globalThis.fetch,
  timeoutMs: number,
): typeof globalThis.fetch {
  return (input, init) => {
    const deadline = AbortSignal.timeout(timeoutMs);
    const caller = init?.signal ?? (input instanceof Request ? input.signal : null);
    const signal = caller ? AbortSignal.any([caller, deadline]) : deadline;
    return fetchImpl(input, { ...init, signal });
  };
}

/** Undici/system codes that mean "the network, not the credential or the API". */
const NETWORK_CODES = new Set([
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
  "EPIPE",
]);

/**
 * Whether a thrown error means GitHub was unreachable — a timeout/abort, an
 * undici transport failure, or a system-level connect error. Octokit wraps fetch
 * failures in a `RequestError` with the original on `.cause`, so the cause chain
 * is walked. NEVER treat a match as a credential problem: marking a token
 * invalid on a network failure would tell the user to disconnect a fine token.
 */
export function isGitHubNetworkError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth += 1) {
    const candidate = current as {
      name?: unknown;
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (candidate.name === "AbortError" || candidate.name === "TimeoutError") return true;
    if (
      typeof candidate.code === "string" &&
      (candidate.code.startsWith("UND_ERR") || NETWORK_CODES.has(candidate.code))
    ) {
      return true;
    }
    // Undici's bare transport failure before any cause detail is attached.
    if (candidate.message === "fetch failed") return true;
    current = candidate.cause;
  }
  return false;
}
