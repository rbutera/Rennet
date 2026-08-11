import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BaselineAdvanceCoordinator,
  type BaselineAdvanceDeps,
  startBaselineWatch,
  type Timers,
  type WatchFn,
} from "./baseline-advance-watcher";

/** A manual timer: `notify` schedules one pending callback; `flush` fires it. */
function fakeTimers(): { timers: Timers; flush: () => void; pending: () => boolean } {
  let cb: (() => void) | null = null;
  return {
    timers: {
      setTimeout: (fn) => {
        cb = fn;
        return {};
      },
      clearTimeout: () => {
        cb = null;
      },
    },
    flush: () => {
      const fn = cb;
      cb = null;
      fn?.();
    },
    pending: () => cb !== null,
  };
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("BaselineAdvanceCoordinator — debounce + coalesce", () => {
  it("a burst of ref writes collapses to ONE pass at the current tip", async () => {
    let tip = "oid0";
    let stored: string | null = "oid0";
    let lastResolved = "oid0";
    const runDeltaPass = vi.fn(async () => {
      stored = lastResolved; // the pass advances the store to the resolved tip
    });
    const t = fakeTimers();
    const deps: BaselineAdvanceDeps = {
      resolveCurrentBaseOid: async () => {
        lastResolved = tip;
        return tip;
      },
      storedBaseOid: () => stored,
      runDeltaPass,
      timers: t.timers,
    };
    const coord = new BaselineAdvanceCoordinator(deps);

    tip = "oid5"; // a merge train landed several commits; the tip is oid5
    coord.notify();
    coord.notify();
    coord.notify();
    coord.notify();
    coord.notify();
    // The burst left exactly one pending debounced drain, not five.
    expect(t.pending()).toBe(true);
    t.flush();
    await coord.whenIdle();

    expect(runDeltaPass).toHaveBeenCalledTimes(1); // one pass, at the tip
    expect(stored).toBe("oid5"); // intermediate OIDs were never built
  });

  it("no movement, no work: an equal re-resolved OID runs no pass", async () => {
    const runDeltaPass = vi.fn(async () => {
      /* no-op pass — the call is recorded by vi.fn */
    });
    const t = fakeTimers();
    const coord = new BaselineAdvanceCoordinator({
      resolveCurrentBaseOid: async () => "same",
      storedBaseOid: () => "same",
      runDeltaPass,
      timers: t.timers,
    });

    coord.notify();
    t.flush();
    await coord.whenIdle();

    expect(runDeltaPass).not.toHaveBeenCalled();
  });

  it("movement DURING an in-flight pass triggers exactly one coalesced catch-up pass", async () => {
    const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));
    let tip = "oid5";
    let stored: string | null = "oid0";
    let lastResolved = "oid0";
    const gate = deferred();
    let firstReleased = false;

    const runDeltaPass = vi.fn(async () => {
      if (!firstReleased) {
        firstReleased = true;
        await gate.promise; // hold the first pass in-flight
      }
      stored = lastResolved; // the pass advances the store to the resolved tip
    });
    const t = fakeTimers();
    const coord = new BaselineAdvanceCoordinator({
      resolveCurrentBaseOid: async () => {
        lastResolved = tip;
        return tip;
      },
      storedBaseOid: () => stored,
      runDeltaPass,
      timers: t.timers,
    });

    coord.notify();
    t.flush();
    await flushMicrotasks(); // let the drain reach the (gated) first pass

    // The first pass is in-flight (awaiting the gate) but the store is unchanged and
    // readable — there is no lock a review waits on.
    expect(runDeltaPass).toHaveBeenCalledTimes(1);
    expect(stored).toBe("oid0");

    // A new commit lands while the pass runs; the tip moves 5 → 7.
    tip = "oid7";
    coord.notify();
    t.flush(); // marks the run dirty (coalesced) — no 2nd concurrent drain

    gate.resolve(); // release the first pass
    await coord.whenIdle();

    // First pass landed oid5; the coalesced catch-up pass landed oid7. Intermediate
    // OIDs were never chased.
    expect(runDeltaPass).toHaveBeenCalledTimes(2);
    expect(stored).toBe("oid7");
  });

  it("a resolve error is reported and never crashes the watcher; later notifies still work", async () => {
    let fail = true;
    const errors: unknown[] = [];
    const runDeltaPass = vi.fn(async () => {
      /* no-op pass — the call is recorded by vi.fn */
    });
    const t = fakeTimers();
    const coord = new BaselineAdvanceCoordinator({
      resolveCurrentBaseOid: async () => {
        if (fail) throw new Error("git blew up");
        return "oid1";
      },
      storedBaseOid: () => "oid0",
      runDeltaPass,
      onError: (e) => errors.push(e),
      timers: t.timers,
    });

    coord.notify();
    t.flush();
    await coord.whenIdle();
    expect(errors).toHaveLength(1);
    expect(runDeltaPass).not.toHaveBeenCalled();

    // The coordinator is not wedged — a later healthy notify still runs a pass.
    fail = false;
    coord.notify();
    t.flush();
    await coord.whenIdle();
    expect(runDeltaPass).toHaveBeenCalledTimes(1);
  });
});

describe("startBaselineWatch — watched ref targets", () => {
  it("watches local refs/heads (+ origin + packed-refs) and a change there drives a pass", async () => {
    const listeners: { path: string; fn: () => void }[] = [];
    const watch: WatchFn = (path, listener) => {
      listeners.push({ path, fn: listener });
      return {
        close: () => {
          /* no teardown needed */
        },
      };
    };
    const t = fakeTimers();
    const runDeltaPass = vi.fn(async () => {
      /* recorded by vi.fn */
    });
    const coord = new BaselineAdvanceCoordinator({
      resolveCurrentBaseOid: async () => "oidTip",
      storedBaseOid: () => "oid0",
      runDeltaPass,
      timers: t.timers,
    });

    const handle = startBaselineWatch("/repo/.git", coord, { watch });
    const paths = listeners.map((l) => l.path);
    // The LOCAL branch tip is now watched — a commit/rebase/reset on main fires, not
    // only a fetch that moves the remote ref.
    expect(paths).toContain(join("/repo/.git", "refs", "heads"));
    expect(paths).toContain(join("/repo/.git", "refs", "remotes", "origin"));
    expect(paths).toContain(join("/repo/.git", "packed-refs"));

    // Firing the refs/heads listener (a local advance) drives notify → debounce → pass.
    const heads = listeners.find((l) => l.path.endsWith(join("refs", "heads")));
    heads?.fn();
    expect(t.pending()).toBe(true);
    t.flush();
    await coord.whenIdle();
    expect(runDeltaPass).toHaveBeenCalledTimes(1);

    handle.close();
  });
});
