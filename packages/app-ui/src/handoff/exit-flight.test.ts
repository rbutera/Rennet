import { describe, expect, it } from "vitest";
import { createFlightBatcher, type FlightClock } from "./exit-flight";

// A hand-driven clock: the batcher only ever keeps ONE window open, so a single pending
// slot is enough. `tick` fires it; `hasPending` proves dispose cancelled it.
function fakeClock() {
  let pending: (() => void) | null = null;
  const clock: FlightClock = {
    setTimeout: (fn) => {
      pending = fn;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: () => {
      pending = null;
    },
  };
  return {
    clock,
    tick: () => {
      const fn = pending;
      pending = null;
      fn?.();
    },
    hasPending: () => pending !== null,
  };
}

describe("createFlightBatcher", () => {
  it("collapses a burst within one window to a single launch (one bubble per gesture)", () => {
    const { clock, tick } = fakeClock();
    let launches = 0;
    const batcher = createFlightBatcher(() => launches++, clock, 80);

    batcher.signal();
    batcher.signal();
    batcher.signal();
    expect(launches).toBe(0); // nothing until the window flushes

    tick();
    expect(launches).toBe(1); // three composite writes, one flight
  });

  it("a signal after the window launches on its own (a later event pips alone)", () => {
    const { clock, tick } = fakeClock();
    let launches = 0;
    const batcher = createFlightBatcher(() => launches++, clock, 80);

    batcher.signal();
    tick();
    batcher.signal();
    tick();
    expect(launches).toBe(2);
  });

  it("always launches a count of 1 — the pip count is derived, the gesture flies one bubble", () => {
    const { clock, tick } = fakeClock();
    const counts: number[] = [];
    const batcher = createFlightBatcher((n) => counts.push(n), clock, 80);

    batcher.signal();
    batcher.signal();
    tick();
    expect(counts).toEqual([1]);
  });

  it("dispose cancels a pending window", () => {
    const { clock, hasPending } = fakeClock();
    let launches = 0;
    const batcher = createFlightBatcher(() => launches++, clock, 80);

    batcher.signal();
    expect(hasPending()).toBe(true);
    batcher.dispose();
    expect(hasPending()).toBe(false);
    expect(launches).toBe(0);
  });
});
