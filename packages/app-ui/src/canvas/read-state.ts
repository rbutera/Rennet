// ─────────────────────────────────────────────────────────────────────────────
// Read-state (issue #17) — pure, event-sourced, no React, no DOM.
//
// Read-state is defined by ACTIONS only (OQ4): a disposition marks a path read; a
// scrolled-through-but-never-actioned path is at most skimmed; a collapsed or
// never-seen path is unread. Collapse can NEVER mark anything read — the #11 view
// store deliberately "holds NO read state", so this lives as a pure fold over an
// event list rather than as ephemeral view state. The fold is order-independent
// (max-rank), so replaying the same events in any order rebuilds identical
// coverage — the totality/residue guarantee, replayable.
// ─────────────────────────────────────────────────────────────────────────────

export type ReadState = "read" | "skimmed" | "unread";

/**
 * A read-state input. `Actioned` is derived from the review's dispositions (read),
 * `ScrolledPast` from a scroll that never actioned (skimmed), `Collapsed` records
 * that a unit was collapsed (never raises rank — collapse is not read).
 */
export type ViewEvent =
  | { type: "Actioned"; path: string }
  | { type: "ScrolledPast"; path: string }
  | { type: "Collapsed"; path: string };

const RANK: Record<ReadState, number> = { unread: 0, skimmed: 1, read: 2 };

/**
 * Fold view events into a per-path read-state by MAX rank: `Actioned`→read (2),
 * `ScrolledPast`→skimmed (1), everything else→unread (0). Max-rank is commutative,
 * so the fold is order-independent and rebuilds identically on replay. `Collapsed`
 * never raises rank, so collapse can never mark a path read.
 */
export function foldReadState(events: ViewEvent[]): Map<string, ReadState> {
  const rank = new Map<string, number>();
  const raise = (path: string, next: ReadState): void => {
    rank.set(path, Math.max(rank.get(path) ?? 0, RANK[next]));
  };
  for (const event of events) {
    if (event.type === "Actioned") raise(event.path, "read");
    else if (event.type === "ScrolledPast") raise(event.path, "skimmed");
    else raise(event.path, "unread"); // Collapsed: registers the path, never raises
  }
  const state = new Map<string, ReadState>();
  for (const [path, value] of rank) {
    state.set(path, value >= 2 ? "read" : value >= 1 ? "skimmed" : "unread");
  }
  return state;
}

/** The minimal disposition shape this fold reads: its anchor path (B2, #489 — the
 *  protocol `Disposition` is removed this change). */
export interface Disposition {
  anchor: { path: string };
}

/**
 * Derive read (`Actioned`) events from the review's dispositions — the sole source
 * of "read". This is what ties read-state to L2 actions and nothing else: no
 * scroll and no collapse can produce an `Actioned` event.
 */
export function dispositionsToViewEvents(dispositions: Disposition[]): ViewEvent[] {
  return dispositions.map((disposition) => ({
    type: "Actioned" as const,
    path: disposition.anchor.path,
  }));
}

// ── The coverage mosaic: totality/residue over the whole changeset ────────────

export interface MosaicCell {
  path: string;
  state: ReadState;
}

export interface CoverageMosaic {
  cells: MosaicCell[];
  read: number;
  skimmed: number;
  unread: number;
  total: number;
}

/**
 * Project read/skimmed/unread over every path in the changeset, in the reading
 * order given. A path with no event is unread (the residue). Pure over the event
 * list, so replaying the same events (any order) yields a deep-equal mosaic — the
 * replay-determinism criterion.
 */
export function coverageMosaic(paths: string[], events: ViewEvent[]): CoverageMosaic {
  const folded = foldReadState(events);
  const cells = paths.map((path) => ({ path, state: folded.get(path) ?? "unread" }));
  let read = 0;
  let skimmed = 0;
  let unread = 0;
  for (const cell of cells) {
    if (cell.state === "read") read += 1;
    else if (cell.state === "skimmed") skimmed += 1;
    else unread += 1;
  }
  return { cells, read, skimmed, unread, total: cells.length };
}

/**
 * The index of the next UNREAD cell after `fromIndex`, wrapping to the start.
 * Returns -1 when nothing is unread. This is the keyboard-traversal target: jump
 * to the next thing the reviewer has not read (the residue), skipping read and
 * skimmed cells.
 */
export function nextUnread(cells: MosaicCell[], fromIndex: number): number {
  const count = cells.length;
  for (let step = 1; step <= count; step += 1) {
    const index = (fromIndex + step) % count;
    if (cells[index]?.state === "unread") return index;
  }
  return -1;
}
