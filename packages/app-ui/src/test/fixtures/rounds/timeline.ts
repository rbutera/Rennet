import type { RoundLedgerRecord, RoundReportBoard } from "@rennet/protocol";
import {
  advance,
  initialRoundState,
  type LaneRow,
  type LaneVerdict,
  type LensLane,
  type RoundEvent,
  type RoundState,
} from "../../../rounds/round-machine";
import type { RoundsSource } from "../../../rounds/rounds-data";
import { FIXTURE_REPORT_BOARDS } from "./report-board";

// ─────────────────────────────────────────────────────────────────────────────
// The round-run timeline (C09 task 1.3) — the spike's `run-view.tsx` `setInterval`
// clock reborn as an ORDERED list of `RoundEvent`s applied through `advance`. There is
// NO `setTimeout` in a rendering path: the tick is a test/dev-driven input, and folding
// the timeline is pure. `roundStateAtTick(n)` is the injected-clock read; the stateful
// {@link createTimelineRoundsSource} wraps it for the DOM clusters (3/5/9) that drive
// the run live.
// ─────────────────────────────────────────────────────────────────────────────

/** A step row in whichever legal shape its status implies — a settled step may carry its
 *  own account, an unstarted one cannot, and a failed one must carry a reason. */
const row = (
  id: string,
  label: string,
  status: "queued" | "running" | "done",
  detail?: string,
): LaneRow =>
  status === "done"
    ? { id, label, status, ...(detail === undefined ? {} : { detail }) }
    : { id, label, status };

const LENS_NAMES = ["Design", "Sequence", "Decisions", "Flagged", "Noise"] as const;
/** The five lens lanes, all at the same point. A SETTLED set carries its verdict — the
 *  fixture's default is `reworked`, the honest reading of a round that moved the code. */
const lensLanes = (
  status: "queued" | "running" | "drafted" | "done",
  verdict: LaneVerdict = "reworked",
): LensLane[] =>
  LENS_NAMES.map((name) =>
    status === "done"
      ? { id: name.toLowerCase(), label: name, status, verdict }
      : { id: name.toLowerCase(), label: name, status },
  );

/**
 * One work-order round, dispatch → composed, as folded progress events. Mirrors the
 * spike's ROUND_PREP / ROUND_WORK / ROUND_FINISH shape, but every row's status is DATA,
 * advanced by `advance`, never a wall clock.
 */
export const FIXTURE_ROUND_TIMELINE: readonly RoundEvent[] = [
  { type: "dispatched" },
  { type: "prep", rows: [row("worktree", "Created detached worktree", "running")] },
  {
    type: "prep",
    rows: [
      row(
        "worktree",
        "Created detached worktree",
        "done",
        "fix/token-refresh-observability @ round-1",
      ),
      row("asks", "Applied the round's asks", "running"),
    ],
  },
  {
    type: "prep",
    rows: [
      row(
        "worktree",
        "Created detached worktree",
        "done",
        "fix/token-refresh-observability @ round-1",
      ),
      row("asks", "Applied the round's asks", "done", "2 asks"),
    ],
  },
  {
    type: "worker",
    rows: [
      row("w-read", "Read the refresh path", "running", "github-auth.ts"),
      row("w-record", "Wrote a terminal record on every exit", "queued"),
      row("w-report", "Reported the post-send failure as unknown", "queued"),
      row("w-tests", "Tightened the tests", "queued"),
    ],
  },
  {
    type: "worker",
    rows: [
      row("w-read", "Read the refresh path", "done", "github-auth.ts"),
      row("w-record", "Wrote a terminal record on every exit", "running"),
      row("w-report", "Reported the post-send failure as unknown", "queued"),
      row("w-tests", "Tightened the tests", "queued"),
    ],
  },
  {
    type: "worker",
    rows: [
      row("w-read", "Read the refresh path", "done", "github-auth.ts"),
      row("w-record", "Wrote a terminal record on every exit", "done"),
      row("w-report", "Reported the post-send failure as unknown", "done"),
      row("w-tests", "Tightened the tests", "done", "github-auth.test.ts"),
    ],
  },
  { type: "committed" },
  { type: "report", reportBoardId: "report-round-1" },
  { type: "lens", lanes: lensLanes("running") },
  { type: "lens", lanes: lensLanes("done") },
  { type: "composed", generation: "gen2" },
];

/**
 * Fold the timeline up to (and including) tick `n` — the pure injected-clock read.
 * `n <= 0` is the honest-absent start; `n >= length` is the terminal `composed` state.
 */
export function roundStateAtTick(
  n: number,
  timeline: readonly RoundEvent[] = FIXTURE_ROUND_TIMELINE,
): RoundState {
  return timeline.slice(0, Math.max(0, n)).reduce(advance, initialRoundState);
}

/** The tick at which the timeline reaches `composed` (the run is complete). */
export const FIXTURE_ROUND_COMPLETE_TICK = FIXTURE_ROUND_TIMELINE.length;

/**
 * A stateful fixture {@link RoundsSource} over an injected clock — what the DOM clusters
 * drive. `tick()` advances the clock one event; `dispatch()` starts the run and is
 * COUNTED (the double-dispatch guard: cluster 3 asserts a cold run-route mount leaves
 * this at zero). Records and report boards are resolved from the supplied maps.
 */
export interface TimelineRoundsSource {
  readonly source: RoundsSource;
  /** Advance the injected clock one tick (apply the next timeline event). */
  tick(): void;
  /** Jump the clock to tick `n`. */
  setTick(n: number): void;
  /** The current tick. */
  currentTick(): number;
  /** How many times `dispatch` has been called (double-dispatch guard). */
  dispatchCount(): number;
}

export function createTimelineRoundsSource(opts?: {
  readonly timeline?: readonly RoundEvent[];
  readonly records?: readonly RoundLedgerRecord[];
  readonly reportBoards?: Readonly<Record<string, RoundReportBoard>>;
  readonly startTick?: number;
}): TimelineRoundsSource {
  const timeline = opts?.timeline ?? FIXTURE_ROUND_TIMELINE;
  const records = opts?.records ?? [];
  const reportBoards = opts?.reportBoards ?? FIXTURE_REPORT_BOARDS;
  let tick = opts?.startTick ?? 0;
  let dispatches = 0;

  const source: RoundsSource = {
    roundState: () => roundStateAtTick(tick, timeline),
    roundRecords: () => records,
    reportBoard: (id) => reportBoards[id],
    dispatch: async () => {
      dispatches += 1;
      if (tick <= 0) tick = 1; // dispatch starts the run (absent → dispatching)
      return { status: "accepted" };
    },
  };

  return {
    source,
    tick: () => {
      if (tick < timeline.length) tick += 1;
    },
    setTick: (n) => {
      tick = n;
    },
    currentTick: () => tick,
    dispatchCount: () => dispatches,
  };
}
