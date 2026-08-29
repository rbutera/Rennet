// The rounds surface (C09, #489) — the round experience as a set of surfaces over one
// seam: the live run route, the report-as-greeting, the rounds ledger, and the report
// board rendered through the widened C5 registry. Mounted by `routes/app.tsx` (the run
// route) and `review-workspace-route.tsx` (greeting + ledger); re-exported from
// `app-ui/src/index.ts` so the app shell binds the live rounds source (cluster 8,
// `useLiveRoundsSource`) without reaching into deep module paths.
//
// The public surface is exactly the packet's list: the four surfaces, the report
// registry types (C9 widens C5's registry), and the rounds seam — its provider, its
// reads, and the `RoundState`/`ReportBoardResolution` shapes those reads return. The
// pure machine internals (`advance`, `canRevealNewBoards`, `runNavigation`), the fixture
// fence, and the report registry's renderer table stay module-private — every internal
// caller reaches them by deep path, and tests mount them from those paths too.

export type {
  ReportElementOf,
  ReportKind,
  ReportRegistry,
  ReportRenderer,
} from "./report-registry";
export { ReportElement } from "./report-registry";
export { RoundGreeting } from "./round-greeting";
export type { LaneRow, RoundPhase, RoundState } from "./round-machine";
export { RoundReportBoard } from "./round-report";
export {
  type ReportBoardResolution,
  type RoundsSource,
  RoundsSourceProvider,
  useReportBoard,
  useRoundDispatch,
  useRoundRecords,
  useRoundState,
} from "./rounds-data";
export { RoundsLedger } from "./rounds-ledger";
export { RunRoute } from "./run-route";
