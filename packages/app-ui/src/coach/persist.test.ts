import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestWinsPersist } from "./persist";
import type { CoachSnapshot } from "./store";

// C13 fix-loop (finding 2). The provider persists on every dismiss / skip-all / replay;
// the old `void mutate(snapshot)` dropped the promise, so a failed write was silently
// forgotten (reload resurrected a dismissed mark) and became an unobserved rejection.
// These prove the latest-wins single-flight wrapper: a rejecting bridge is retried and
// the latest snapshot survives, and out-of-order completions never let a stale success
// clobber a newer state.

const snap = (seen: CoachSnapshot["seen"], skipAll = false): CoachSnapshot => ({ seen, skipAll });

/** Flush pending microtasks — enough hops to drain a `.then().catch().then()` chain. */
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** A controllable async sink: each call parks a deferred the test resolves/rejects by hand. */
function deferredSink() {
  const calls: Array<{ snapshot: CoachSnapshot; resolve: () => void; reject: () => void }> = [];
  const send = (snapshot: CoachSnapshot) =>
    new Promise<void>((resolve, reject) => {
      calls.push({ snapshot, resolve: () => resolve(), reject: () => reject(new Error("boom")) });
    });
  return { calls, send };
}

describe("createLatestWinsPersist (C13 finding 2)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("retries a failed write and lands the LATEST snapshot after recovery", async () => {
    const { calls, send } = deferredSink();
    const persist = createLatestWinsPersist(send, 10);

    persist(snap(["start-review"])); // first attempt
    expect(calls).toHaveLength(1);

    // The bridge rejects (malformed config / transport). An observed catch — no unhandled
    // rejection — retains the snapshot and arms the retry.
    calls[0]?.reject();
    await flush();

    // A newer change arrives before the retry timer: it supersedes and fires at once.
    persist(snap(["start-review", "new-chat"], true));
    await flush();
    expect(calls).toHaveLength(2);
    // The retry carries the NEWEST snapshot, not the stale one that failed.
    expect(calls[1]?.snapshot).toEqual(snap(["start-review", "new-chat"], true));

    calls[1]?.resolve();
    await flush();
    // Converged: no further writes fire once the latest has landed.
    expect(calls).toHaveLength(2);
  });

  it("retries on its own timer when no fresh change arrives", async () => {
    const { calls, send } = deferredSink();
    const persist = createLatestWinsPersist(send, 10);

    persist(snap(["fab"]));
    calls[0]?.reject();
    await flush();
    expect(calls).toHaveLength(1);

    // No new change — the short retry timer re-fires the retained snapshot.
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.snapshot).toEqual(snap(["fab"]));
  });

  it("single-flights: an out-of-order completion never clobbers the newer state", async () => {
    const { calls, send } = deferredSink();
    const persist = createLatestWinsPersist(send, 10);

    persist(snap(["start-review"])); // v1 starts, slow
    expect(calls).toHaveLength(1);

    // A newer change arrives while v1 is still in flight. Single-flight holds it —
    // no second write races v1.
    persist(snap(["start-review", "new-chat"])); // v2 queued
    expect(calls).toHaveLength(1);

    // v1 finally lands. Only now does the newer v2 fire — after, not concurrent with, v1.
    calls[0]?.resolve();
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.snapshot).toEqual(snap(["start-review", "new-chat"]));

    // v2 lands last, so the newest state is what persisted — no stale clobber.
    calls[1]?.resolve();
    await flush();
    expect(calls).toHaveLength(2);
  });
});
