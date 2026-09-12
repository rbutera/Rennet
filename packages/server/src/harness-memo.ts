// The harness-discovery memo's eviction rule (session-thread-briefing round 5, Codex).
//
// `create-server` memoises two harness resolutions per locus — the Claude adapter and the
// Codex resolution — because discovery spawns a login shell and a handshake probe. This is
// the one rule both go through, lifted out of the composition root so it is executable: a
// composition root is not testable, and "a transient failure must not become permanent" is a
// property, not a comment.

/**
 * Memoise a harness resolution ONLY when it found something (Codex's round-5 finding).
 *
 * Both of these caches kept whatever the first probe answered, forever — including
 * `adapter: null` and including a REJECTED promise. Discovery spawns a login shell and a
 * handshake probe, so one descriptor exhaustion, one asdf version drift, one slow moment
 * at daemon start pinned "that harness does not exist here" for the daemon's whole life.
 * It never showed as an error, because the shape of "not installed" and the shape of
 * "could not be asked" are the same shape downstream.
 *
 * That was survivable while the caches only fed the lens seats, which run once per
 * generation and re-probe on the next daemon. It is not survivable now: the session
 * thread's council routing reads them on every FRESH bind (`resolveSessionThreadModel`
 * caches nothing precisely so a transient failure cannot pin a provider), and a permanent
 * negative behind it defeats that — the reviewer's stored Codex choice would route to
 * Claude until they restarted Rennet, silently.
 *
 * So a SUCCESS stays memoised, exactly as before, and a failure or an unavailable answer
 * is evicted so the next caller probes again. The in-flight promise is still shared, so
 * concurrent callers never start two discoveries.
 */
export function memoiseOnlyAvailable<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  resolution: Promise<T>,
  isAvailable: (value: T) => boolean,
): Promise<T> {
  return resolution.then(
    (value) => {
      if (!isAvailable(value)) cache.delete(key);
      return value;
    },
    (error: unknown) => {
      cache.delete(key);
      throw error;
    },
  );
}
