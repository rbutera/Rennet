export interface WindowRange {
  start: number;
  end: number;
}
export function windowRows(input: {
  total: number;
  rowHeight: number;
  viewportHeight: number;
  scrollTop: number;
  overscan?: number;
}): WindowRange {
  const overscan = input.overscan ?? 6;
  const visibleRows = Math.ceil(input.viewportHeight / input.rowHeight);
  const maxFirst = Math.max(0, input.total - visibleRows);
  const first = Math.min(Math.max(0, Math.floor(input.scrollTop / input.rowHeight)), maxFirst);
  const start = Math.max(0, first - overscan);
  const end = Math.min(input.total, first + visibleRows + overscan);
  return { start, end };
}

/**
 * The top edge of every row, plus the total height, for rows whose heights are known
 * only where they have been painted. `offsets[i]` is where row `i` starts and
 * `offsets[total]` is the whole column; a row without a measurement takes `estimate`.
 *
 * This is what lets a virtualised column WRAP: a row that wrapped is taller than its
 * estimate, and once it has been measured every row below it moves down by the
 * difference instead of being painted over it.
 */
export function rowOffsets(
  total: number,
  estimate: number,
  heights: ReadonlyMap<number, number>,
): number[] {
  const offsets = new Array<number>(total + 1);
  let top = 0;
  for (let index = 0; index < total; index++) {
    offsets[index] = top;
    top += heights.get(index) ?? estimate;
  }
  offsets[total] = top;
  return offsets;
}

/** The rows that intersect the viewport when rows have measured offsets. */
export function windowMeasuredRows(input: {
  offsets: readonly number[];
  viewportHeight: number;
  scrollTop: number;
  overscan?: number;
}): WindowRange {
  const overscan = input.overscan ?? 6;
  const total = input.offsets.length - 1;
  if (total <= 0) return { start: 0, end: 0 };
  const top = Math.max(0, input.scrollTop);
  const bottom = top + input.viewportHeight;
  // First row whose bottom edge is below the viewport top.
  let lo = 0;
  let hi = total - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((input.offsets[mid + 1] ?? 0) > top) hi = mid;
    else lo = mid + 1;
  }
  const first = lo;
  let last = first;
  while (last + 1 < total && (input.offsets[last + 1] ?? 0) < bottom) last++;
  return {
    start: Math.max(0, first - overscan),
    end: Math.min(total, last + 1 + overscan),
  };
}
