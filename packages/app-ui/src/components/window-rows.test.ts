import { describe, expect, it } from "vitest";
import { rowOffsets, windowMeasuredRows, windowRows } from "./window-rows";

describe("rowOffsets", () => {
  it("stacks the estimate for every unmeasured row and the measurement where there is one", () => {
    const offsets = rowOffsets(4, 22, new Map([[1, 44]]));
    expect(offsets).toEqual([0, 22, 66, 88, 110]);
  });
});

describe("windowMeasuredRows", () => {
  it("agrees with the fixed-height window when nothing is measured", () => {
    const offsets = rowOffsets(20000, 22, new Map());
    const fixed = windowRows({ total: 20000, rowHeight: 22, viewportHeight: 440, scrollTop: 0 });
    expect(windowMeasuredRows({ offsets, viewportHeight: 440, scrollTop: 0 })).toEqual(fixed);
    const deep = windowMeasuredRows({ offsets, viewportHeight: 440, scrollTop: 19980 * 22 });
    expect(deep.start).toBeLessThanOrEqual(19980);
    expect(deep.end).toBe(20000);
  });

  it("moves the window by the measured height of the rows above it", () => {
    // Row 0 wrapped to three lines (66px). Scrolled by 66px, row 1 is the first visible;
    // with the estimate alone the window would have skipped to row 3.
    const offsets = rowOffsets(100, 22, new Map([[0, 66]]));
    const range = windowMeasuredRows({ offsets, viewportHeight: 44, scrollTop: 66, overscan: 0 });
    expect(range).toEqual({ start: 1, end: 3 });
  });

  it("handles an empty column", () => {
    expect(windowMeasuredRows({ offsets: [0], viewportHeight: 440, scrollTop: 0 })).toEqual({
      start: 0,
      end: 0,
    });
  });
});
