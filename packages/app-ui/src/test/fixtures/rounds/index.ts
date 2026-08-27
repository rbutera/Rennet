import type { RoundsSource } from "../../../rounds/rounds-data";
import { completedRoundRecord, FIXTURE_REPORT_BOARDS } from "./report-board";

export {
  completedRoundRecord,
  FIXTURE_REPORT_BOARDS,
  reportBoardFixture,
  roundOutcome,
} from "./report-board";
export {
  createTimelineRoundsSource,
  FIXTURE_ROUND_COMPLETE_TICK,
  FIXTURE_ROUND_TIMELINE,
  roundStateAtTick,
  type TimelineRoundsSource,
} from "./timeline";

// ─────────────────────────────────────────────────────────────────────────────
// The rounds fixture bridge (C09 task 1.3), mirroring `../boards/index.ts`. A surface
// never imports this directory (the import fence); a test hands one of these sources to
// `RoundsSourceProvider`. See `rounds/rounds-data.ts` for the seam these satisfy.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A completed-round fixture source — one round in the ledger, its report board
 * resolvable, and the run machine already at `composed`. What the ledger and greeting
 * tests read (the live-run tests drive {@link createTimelineRoundsSource} instead).
 */
export const fixtureCompletedRoundsSource: RoundsSource = {
  roundState: () => ({
    phase: "composed",
    reportBoardId: completedRoundRecord.reportBoard,
    newGeneration: completedRoundRecord.mintedPatchsetGeneration ?? "gen2",
  }),
  roundRecords: () => [completedRoundRecord],
  reportBoard: (id) => FIXTURE_REPORT_BOARDS[id],
};
