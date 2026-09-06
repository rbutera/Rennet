import type { DiscoveryResult } from "@rennet/adapters";
import type { ProviderBinaries } from "./sidecar";

// ─────────────────────────────────────────────────────────────────────────────
// #890 — A DISCOVERY PROBE THAT FAILS MUST SAY SO.
//
// The T3 sidecar runs the same absolute `claude`/`codex` paths Rennet's own discovery
// resolved, so a GUI-launched daemon with launchd's PATH still gets working binaries. When
// that resolution failed, it failed in total silence, two different ways:
//
//   const [claude, codex] = await Promise.all([
//     discoverClaude(...).catch(() => null),          // ← the throw, discarded
//     discoverCodex(...).catch(() => null),
//   ]);
//   return { ...(codex?.chosen ? { codex: codex.chosen.path } : {}) };  // ← health, discarded
//
// `.catch(() => null)` threw away the error without a line, and a result with `chosen: null`
// threw away `health.reason`/`health.detail` — the sentences discovery went to real trouble
// to produce ("codex X at Y did not answer the app-server initialize handshake",
// "spawn-failed", "not-found" listing every location searched).
//
// So when the Codex app-server handshake probe failed — descriptors exhausted, asdf version
// drift, a broken vendored native binary — the sidecar simply came up with no `codex` path,
// the Codex board seat failed later with something unrelated, and nothing anywhere said why.
// The daemon.log behind #890 is exactly that shape: `EBADF, syscall: 'spawn'` over and over,
// and not one line naming the harness it cost.
//
// CONTAINMENT, NOT A GATE. Both probes still run, both harnesses stay on by default, neither
// becomes opt-in, and a failure still degrades to "no path for that harness" rather than
// failing the daemon. The only change is that it is legible while it does that.
// ─────────────────────────────────────────────────────────────────────────────

export interface ProviderBinaryDiscovery {
  /** Discover the host's `claude`. Rejects or returns `chosen: null` when it cannot. */
  readonly claude: () => Promise<DiscoveryResult>;
  /** Discover the host's `codex`, app-server handshake and all. */
  readonly codex: () => Promise<DiscoveryResult>;
  /** Where a degraded harness is named. Defaults to `console.warn`. */
  readonly warn?: (message: string) => void;
}

/** A thrown discovery failure as a sentence. */
const describeDiscoveryFailure = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Resolve the sidecar's provider binaries, naming every harness it could not resolve.
 *
 * Both harnesses are probed concurrently and independently: one that cannot be found never
 * costs the other, which is the behaviour the old `Promise.all` + `.catch` pair already had
 * and is worth keeping.
 */
export async function resolveProviderBinaries(
  deps: ProviderBinaryDiscovery,
): Promise<ProviderBinaries> {
  const warn = deps.warn ?? console.warn;
  const resolve = async (
    harness: "claude" | "codex",
    discover: () => Promise<DiscoveryResult>,
  ): Promise<string | undefined> => {
    let result: DiscoveryResult;
    try {
      result = await discover();
    } catch (error) {
      warn(
        `rennet: ${harness} discovery failed: ${describeDiscoveryFailure(error)} — the T3 sidecar starts without ${harness}.`,
      );
      return undefined;
    }
    if (result.chosen) return result.chosen.path;
    // Discovery answered, and its answer was "no". It knows WHY; say it.
    const health = result.health;
    const reason = health.state === "unavailable" ? health.reason : health.state;
    const detail =
      health.state === "unavailable" && health.detail !== undefined
        ? health.detail
        : "discovery chose no binary.";
    warn(
      `rennet: ${harness} unavailable (${reason}): ${detail} — the T3 sidecar starts without ${harness}.`,
    );
    return undefined;
  };
  const [claude, codex] = await Promise.all([
    resolve("claude", deps.claude),
    resolve("codex", deps.codex),
  ]);
  return {
    ...(claude === undefined ? {} : { claude }),
    ...(codex === undefined ? {} : { codex }),
  };
}
