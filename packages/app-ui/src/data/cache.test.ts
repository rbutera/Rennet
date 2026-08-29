import { commands } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { CommandCache, commandKey, readCommandId } from "./cache";

// Late-read regressions (C01 review finding 1). A fetch that started BEFORE a mutation
// invalidated its key must not, on completion, erase that invalidation or clobber state
// a stream folded during the flight. Deferred promises reproduce both orderings exactly.

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flush the microtask + macrotask queues so chained `.then` handlers all run. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("CommandCache — late reads never erase invalidation or streamed data", () => {
  it("invalidate-during-flight: the superseded completion refetches instead of clearing stale", async () => {
    const cache = new CommandCache();
    const key = commandKey("projects.list", {});
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const pending = [first, second];
    let calls = 0;
    const fetcher = () => {
      const next = pending[calls++];
      if (!next) throw new Error("unexpected extra fetch (runaway refetch loop)");
      return next.promise;
    };

    // A MOUNTED reader. `ensure` is only ever reached from `useCommand`, which subscribes
    // first — and a key with no readers is now treated as abandoned (the reopen test
    // below), so an invalidation with nobody watching deliberately does NOT refetch.
    cache.subscribe(key, () => undefined);
    cache.ensure(key, fetcher);
    expect(calls).toBe(1); // the first fetch is in flight

    // A mutation invalidates the in-flight key.
    cache.invalidate("projects.list");
    expect(cache.getSnapshot(key).stale).toBe(true);

    // The PRE-invalidation fetch now resolves with pre-mutation data.
    first.resolve({ projects: ["stale"] });
    await tick();

    // The completion must have refetched (not cleared the invalidation and stopped):
    // a second fetch is now in flight, so the entry is actively fetching, not idle-stale.
    expect(calls).toBe(2);
    expect(cache.getSnapshot(key).fetching).toBe(true);

    // The refetch resolves with fresh post-mutation data.
    second.resolve({ projects: ["fresh"] });
    await tick();
    const snap = cache.getSnapshot(key);
    expect(snap.stale).toBe(false);
    expect(snap.data).toEqual({ projects: ["fresh"] });
    expect(calls).toBe(2); // no runaway refetch loop
  });

  it("reject-after-stream-fold: a rejection preserves streamed data, not a pre-fetch snapshot", async () => {
    const cache = new CommandCache();
    const key = commandKey("project.process", { commandId: "c1", projectId: "p1" });
    const fetch = deferred<unknown>();

    cache.ensure(key, () => fetch.promise);
    // A stream folds newer state while the fetch is still in flight.
    cache.setData(key, () => ({ repos: ["streamed"] }));
    expect(cache.getSnapshot(key).data).toEqual({ repos: ["streamed"] });

    // The fetch REJECTS after the fold.
    fetch.reject(new Error("boom"));
    await tick();

    const snap = cache.getSnapshot(key);
    expect(snap.error).toBeInstanceOf(Error);
    // The streamed data survives — the rejection did NOT restore the pre-stream snapshot.
    expect(snap.data).toEqual({ repos: ["streamed"] });
  });

  it("resolve-after-snapshot: an older read cannot replace a pushed full projection", async () => {
    const cache = new CommandCache();
    const key = commandKey("ask.read", { sessionId: "review-1" });
    const first = deferred<unknown>();
    let calls = 0;
    const fetcher = () => {
      calls += 1;
      return first.promise;
    };

    cache.subscribe(key, () => undefined);
    cache.ensure(key, fetcher);
    cache.setData(key, () => ({ projection: { stagedAsks: {} } }), {
      supersedeInFlight: true,
    });

    first.resolve({ projection: { stagedAsks: { stale: { id: "stale" } } } });
    await tick();
    expect(cache.getSnapshot(key).data).toEqual({ projection: { stagedAsks: {} } });
    expect(cache.getSnapshot(key).stale).toBe(false);
    expect(calls).toBe(1);
  });

  it("resolve-after-delta: the catch-up read still installs for the owner to merge", async () => {
    const cache = new CommandCache();
    const key = commandKey("session.roundEvents", { reviewId: "review-1" });
    const first = deferred<unknown>();

    cache.subscribe(key, () => undefined);
    cache.ensure(key, () => first.promise);
    cache.setData(key, () => ({ events: [{ type: "composed", seq: 5 }] }));

    first.resolve({ events: [{ type: "dispatched", seq: 0 }] });
    await tick();
    expect(cache.getSnapshot(key).data).toEqual({
      events: [{ type: "dispatched", seq: 0 }],
    });
  });

  it("getSnapshot does not create an entry (no render-phase mutation)", () => {
    const cache = new CommandCache();
    const key = commandKey("projects.list", {});
    // Reading an absent key returns IDLE and leaves the store untouched: a later
    // invalidate finds nothing to mark, proving no entry was created by the read.
    expect(cache.getSnapshot(key).data).toBeUndefined();
    cache.invalidate("projects.list");
    expect(cache.getSnapshot(key).stale).toBe(false);
  });

  // ── Abandonment: what a reader is served when it comes BACK ──────────────────
  // A surface that closes and reopens (leaving `/s/:slug` and returning) must be shown what
  // the daemon holds now. The entry's key is stable, so without this the reopen hits a
  // "fresh" cached snapshot, `ensure` skips the read entirely, and every message that
  // arrived while the route was closed is silently missing until a full reload.

  it("an abandoned key goes stale, so the next reader RE-READS instead of re-showing", async () => {
    const cache = new CommandCache();
    const key = commandKey("review.reattach", {
      commandId: "00000000-0000-4000-8000-000000000001",
      reviewId: "r1",
    });
    let served = "before";
    let calls = 0;
    const fetcher = () => {
      calls += 1;
      return Promise.resolve({ body: served });
    };

    const unsubscribe = cache.subscribe(key, () => undefined);
    cache.ensure(key, fetcher);
    await tick();
    expect(cache.getSnapshot(key).data).toEqual({ body: "before" });
    expect(calls).toBe(1);

    // The reader leaves. The server moves on while nobody is watching.
    unsubscribe();
    served = "after";

    // The reader comes back on the SAME key — and must see the server's answer, not its own
    // parting snapshot. The old rows stay on screen through the refetch (stale, not dropped).
    expect(cache.getSnapshot(key).data).toEqual({ body: "before" });
    cache.subscribe(key, () => undefined);
    cache.ensure(key, fetcher);
    await tick();
    expect(calls).toBe(2);
    expect(cache.getSnapshot(key).data).toEqual({ body: "after" });
  });

  it("abandoned MID-FLIGHT: the completion cannot land as fresh, and refetches for nobody", async () => {
    const cache = new CommandCache();
    const key = commandKey("review.reattach", {
      commandId: "00000000-0000-4000-8000-000000000002",
      reviewId: "r2",
    });
    const first = deferred<unknown>();
    let calls = 0;
    const fetcher = () => {
      calls += 1;
      return calls === 1 ? first.promise : Promise.resolve({ body: "after" });
    };

    const unsubscribe = cache.subscribe(key, () => undefined);
    cache.ensure(key, fetcher);
    unsubscribe(); // left before the read landed
    first.resolve({ body: "before" });
    await tick();

    // The in-flight completion may not clear a staleness it never saw…
    expect(cache.getSnapshot(key).stale).toBe(true);
    // …and must not spend a round trip refetching for a reader that is gone.
    expect(calls).toBe(1);
  });

  it("an IMMUTABLE read stays fresh when abandoned — a patchset span cannot change", async () => {
    // POSITIVE CONTROL in the other direction: the rule above must not turn every re-open of
    // an evidence card into a re-read. A patchset is fixed at capture (architecture contract),
    // so its span reads the same bytes forever and the cached answer is still the truth.
    const cache = new CommandCache();
    const key = commandKey("patchset.readSpan", {
      patchsetId: "ps-1",
      path: "one.ts",
      side: "head",
      startLine: 10,
      endLine: 10,
    });
    let calls = 0;
    const fetcher = () => {
      calls += 1;
      return Promise.resolve({ lines: ["x"], contextBefore: [], contextAfter: [] });
    };

    const unsubscribe = cache.subscribe(key, () => undefined);
    cache.ensure(key, fetcher);
    await tick();
    unsubscribe();

    cache.subscribe(key, () => undefined);
    cache.ensure(key, fetcher);
    await tick();
    expect(calls).toBe(1);
  });

  // The whole point of `readCommandId`: the wire rejects anything that is not a UUID, so a
  // readable `load-${slug}` made every session route fail to load on the real app.
  //
  // This is a check on the HELPER and nothing more — on its own it stays green while a call
  // site goes back to sending `load-${slug}`, because it never executes one. What makes a
  // reintroduced hand-written id redden is `MemoryBridge.invoke` parsing every invocation
  // against the same schema the daemon uses: the `/s/:slug` and chat-dock DOM tests then
  // fail at the real construction site. Keep both; neither replaces the other.
  it("readCommandId is a wire-valid uuid, stable per key and distinct across keys", () => {
    const first = readCommandId("review.load:abc");
    expect(readCommandId("review.load:abc")).toBe(first);
    expect(readCommandId("review.load:xyz")).not.toBe(first);
    for (const id of [first, "load-abc"]) {
      const parsed = commands["review.load"].args.safeParse({ commandId: id, reviewId: "abc" });
      expect(parsed.success).toBe(id === first);
    }
  });
});
