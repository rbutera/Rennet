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
