// Detection reads must stay LIVE (C17 review finding 2). The daemon's CLI-detection probes
// (claude, codex, `gh`, per host) were memoized for the process lifetime, which turned a
// disclosure into a lie the moment the machine changed: install `gh`, or remove it, and every
// host card kept reporting the answer from the first probe until the daemon restarted.
//
// The cost the memoization was paying for is real — each probe spawns a login shell, and the
// settings surface re-reads on every render and every toggle — but the fix for "expensive" is
// to share the probe that is ALREADY RUNNING, not to keep its answer forever. So: dedupe
// in flight, evict on settlement. Concurrent callers get one probe; the next caller after it
// settles gets a fresh one, and a binary that came or went is visible immediately.

/** A single-slot in-flight share: concurrent callers join the running probe, and the first
 *  caller after it settles starts a new one. */
export function liveProbe<T>(): (run: () => Promise<T>) => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return (run) => {
    inFlight ??= run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

/** The same share, keyed — one in-flight probe per host, evicted when that host's settles. */
export function liveProbeMap<T>(): (key: string, run: () => Promise<T>) => Promise<T> {
  const inFlight = new Map<string, Promise<T>>();
  return (key, run) => {
    let pending = inFlight.get(key);
    if (!pending) {
      pending = run().finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }
    return pending;
  };
}
