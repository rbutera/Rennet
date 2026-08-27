import { describe, expect, it } from "vitest";
import { CommandCache, commandKey } from "./cache";

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

  it("getSnapshot does not create an entry (no render-phase mutation)", () => {
    const cache = new CommandCache();
    const key = commandKey("projects.list", {});
    // Reading an absent key returns IDLE and leaves the store untouched: a later
    // invalidate finds nothing to mark, proving no entry was created by the read.
    expect(cache.getSnapshot(key).data).toBeUndefined();
    cache.invalidate("projects.list");
    expect(cache.getSnapshot(key).stale).toBe(false);
  });
});
