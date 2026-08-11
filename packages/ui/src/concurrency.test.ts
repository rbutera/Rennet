import { describe, expect, it } from "vitest";
import { runBatched } from "./concurrency";

describe("runBatched — bounds concurrent work (#19 'Refine all')", () => {
  it("never runs more than `concurrency` at once", async () => {
    let active = 0;
    let peak = 0;
    const resolvers: Array<() => void> = [];
    const items = Array.from({ length: 10 }, (_, i) => i);
    const fn = (): Promise<void> => {
      active += 1;
      peak = Math.max(peak, active);
      return new Promise<void>((resolve) => {
        resolvers.push(() => {
          active -= 1;
          resolve();
        });
      });
    };

    const done = runBatched(items, 3, fn);
    // Let the first batch start. With a real bound only 3 run before any resolves;
    // an unbounded `Promise.all(items.map(fn))` would push peak to 10 here → red.
    await Promise.resolve();
    expect(peak).toBeLessThanOrEqual(3);

    // Drain wave by wave until every item has run.
    for (let pump = 0; pump < 20 && resolvers.length > 0; pump += 1) {
      const wave = resolvers.splice(0, resolvers.length);
      for (const resolve of wave) resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
    await done;
    // The cap held across every batch, not just the first.
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("runs every item exactly once, and tolerates concurrency < 1", async () => {
    const seen: number[] = [];
    await runBatched([1, 2, 3, 4, 5], 0, async (n) => {
      seen.push(n);
    });
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });
});
