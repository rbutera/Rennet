import { describe, expect, it } from "vitest";
import { memoiseOnlyAvailable } from "./harness-memo";
import { resolveSessionThreadModel } from "./t3/orchestrator-chat";

// ─────────────────────────────────────────────────────────────────────────────
// session-thread-briefing round 5, item 5 (Codex) — A TRANSIENT FAILURE MUST NOT BECOME
// PERMANENT.
//
// `resolveSessionThreadModel` deliberately caches nothing, so that one bad discovery moment
// cannot pin a provider. That was only half the path: the probes it calls sit behind
// `create-server`'s two per-locus harness memos, which kept whatever the FIRST probe
// answered — `adapter: null`, `available: false`, and a rejected promise — for the daemon's
// whole life. Codex reproduced it as "two unavailable answers, one discovery call": a fresh
// resolver reaching a permanent negative, so the reviewer's stored Codex choice routed to
// Claude until they restarted Rennet, with nothing anywhere saying why.
//
// The shape of "not installed" and the shape of "could not be asked" are identical
// downstream, which is why this was silent.
// ─────────────────────────────────────────────────────────────────────────────

/** A memoising resolver in `create-server`'s exact shape: a Map, a key, one probe per miss. */
function cachedProbe<T>(probe: () => Promise<T>, isAvailable: (value: T) => boolean) {
  const cache = new Map<string, Promise<T>>();
  let probes = 0;
  const get = (key = "host"): Promise<T> => {
    const hit = cache.get(key);
    if (hit) return hit;
    probes += 1;
    const resolution = memoiseOnlyAvailable(cache, key, probe(), isAvailable);
    cache.set(key, resolution);
    return resolution;
  };
  return { get, probes: () => probes, size: () => cache.size };
}

describe("the harness memo keeps a success and drops a failure", () => {
  it("re-probes after a REJECTED discovery, so a descriptor exhaustion is not permanent", async () => {
    let attempt = 0;
    const probe = cachedProbe(
      async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("spawn EBADF");
        return { available: true };
      },
      (value) => value.available,
    );
    await expect(probe.get()).rejects.toThrow("spawn EBADF");
    // Evicted, so the next caller asks again rather than inheriting the rejection.
    expect(probe.size()).toBe(0);
    expect(await probe.get()).toEqual({ available: true });
    expect(probe.probes()).toBe(2);
  });

  it("re-probes after an UNAVAILABLE answer, which is the shape discovery really returns", async () => {
    // `createClaudeHarness` resolves `{ adapter: null, discovery }` rather than rejecting, and
    // `getCodexResolution` resolves `{ available: false }`. Neither is an error, and both were
    // cached as the final word.
    let attempt = 0;
    const probe = cachedProbe(
      async () => {
        attempt += 1;
        return { available: attempt > 1 };
      },
      (value) => value.available,
    );
    expect(await probe.get()).toEqual({ available: false });
    expect(await probe.get()).toEqual({ available: true });
    expect(probe.probes()).toBe(2);
  });

  it("keeps a success memoised — discovery spawns a login shell and must not run per call", async () => {
    // The control. Without this the fix would be "never memoise", which pays a login shell
    // on every bind and every seat.
    const probe = cachedProbe(
      async () => ({ available: true }),
      (value) => value.available,
    );
    await probe.get();
    await probe.get();
    await probe.get();
    expect(probe.probes()).toBe(1);
  });

  it("shares one in-flight probe between concurrent callers", async () => {
    // Eviction happens on SETTLE, so the window where two callers could each start a
    // discovery is still closed — which is what the memo was for in the first place.
    let started = 0;
    const probe = cachedProbe(
      async () => {
        started += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { available: false };
      },
      (value) => value.available,
    );
    await Promise.all([probe.get(), probe.get(), probe.get()]);
    expect(started).toBe(1);
  });
});

describe("the session thread's routing recovers with the memo", () => {
  it("answers Codex on the bind after a transient failure, not Claude forever", async () => {
    // End to end over the two halves: the uncached resolver on top, the evicting memo
    // underneath. This is Codex's "two unavailable answers, one discovery call", fixed.
    let attempt = 0;
    const codexProbe = cachedProbe(
      async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("codex app-server handshake timed out");
        return { available: true };
      },
      (value) => value.available,
    );
    const probes = {
      claudeAvailable: async () => true,
      codexAvailable: async () => (await codexProbe.get()).available,
      disabledHarnesses: () => [],
      sidecarBinaries: () => ({ claude: "/bin/claude", codex: "/bin/codex" }),
      // The reviewer chose Codex in the welcome: a `dual`-column task override.
      overrides: () => ({ task: { "orchestrator-chat": { model: "gpt-5.6-terra" } } }) as never,
    };
    // First bind: the probe rejected, so nothing is claimed and the thread opens on the
    // sidecar's default with a line in the log.
    expect(await resolveSessionThreadModel("/repo", probes)).toBeUndefined();
    // Second bind: recovered, and the reviewer's own choice is honoured. Under the old
    // caches this answered Claude for the daemon's whole life.
    expect((await resolveSessionThreadModel("/repo", probes))?.instanceId).toBe("codex");
    expect(codexProbe.probes()).toBe(2);
  });
});
