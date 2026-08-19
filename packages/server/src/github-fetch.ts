/**
 * Connect-phase resilience for GitHub egress (observed live on lancelot,
 * 2026-08-19: a raw undici "Connect Timeout Error (attempted address:
 * api.github.com:443, timeout: 10000ms)" surfaced in the UI during a transient
 * network-path failure — WSL NAT DNS measured at 2.4s cold, sleep/wake worse).
 *
 * Two behaviours, both confined to CONNECT-PHASE failures (no connection was
 * ever established, so no request reached GitHub — a retry can never double an
 * effect, POST included):
 *  • one retry after a short pause, absorbing a momentary blip;
 *  • a plain-language error when the retry also fails, so the UI says "GitHub
 *    is unreachable — check the network" instead of leaking undici internals.
 */

import { withRequestTimeout } from "@rennet/adapters";

/** Undici error codes that mean the CONNECTION never happened. */
const CONNECT_PHASE_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "EAI_AGAIN", // transient DNS failure
  "ENETUNREACH",
  "ENOTFOUND",
]);

const RETRY_DELAY_MS = 750;

/**
 * Sleep that an abort interrupts. The retry pause must NOT be a blind spot: the
 * composed request deadline (and a caller cancel) arrives as `init.signal`, and a
 * pause that ignored it would extend the total budget past the deadline — the
 * aggregate bound is the contract, so the abort wins mid-pause too.
 */
function abortableDelay(ms: number, signal: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function connectPhaseCode(error: unknown): string | null {
  const cause = (error as { cause?: { code?: unknown } })?.cause;
  const code = cause?.code ?? (error as { code?: unknown })?.code;
  return typeof code === "string" && CONNECT_PHASE_CODES.has(code) ? code : null;
}

/** Wrap a fetch so GitHub egress absorbs one connect blip and fails in plain words. */
export function withConnectResilience(
  fetchImpl: typeof globalThis.fetch,
  delayMs: number = RETRY_DELAY_MS,
): typeof globalThis.fetch {
  return async (input, init) => {
    try {
      return await fetchImpl(input, init);
    } catch (first) {
      const code = connectPhaseCode(first);
      if (code === null) throw first;
      // Diagnostic breadcrumb (field lesson, 2026-08-19): a connect failure's
      // family/address is the difference between "the network is down" and "one
      // family is broken" — log the raw cause once so the NEXT report is
      // diagnosable from daemon.log instead of reconstructed from probes.
      console.warn(
        "[github-egress] connect failure (%s), retrying once:",
        code,
        (first as { cause?: { message?: string } })?.cause?.message ?? (first as Error)?.message,
      );
      const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
      await abortableDelay(delayMs, signal);
      try {
        return await fetchImpl(input, init);
      } catch (second) {
        if (connectPhaseCode(second) === null) throw second;
        const host = (() => {
          try {
            return new URL(String(input)).host;
          } catch {
            return "GitHub";
          }
        })();
        throw new Error(
          `GitHub is unreachable right now (the connection to ${host} timed out; ${code}). ` +
            "Check the network or VPN and try again — nothing was sent.",
          { cause: second },
        );
      }
    }
  };
}

/**
 * THE production GitHub transport stack — the one place it is assembled. The
 * deadline wraps OUTSIDE the retry (one absolute budget spans both attempts),
 * and tests consume this same factory so a mutation here bites them.
 */
export function composeGitHubTransport(
  raw: typeof globalThis.fetch,
  timeoutMs: number,
): typeof globalThis.fetch {
  return withRequestTimeout(withConnectResilience(raw), timeoutMs);
}
