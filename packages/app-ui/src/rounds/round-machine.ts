import type {
  GenerationCoverage,
  LaneRow,
  LensLane,
  RoundEvent,
  RoundOperationProgressSnapshot,
  RoundReportBoard,
} from "@rennet/protocol";
import { type Navigation, sessionPath } from "../routes/url";

// ─────────────────────────────────────────────────────────────────────────────
// The round run state machine (C09 §1, autopsy S9 fence). A PURE, transition-driven
// model of one work-order round from dispatch to a composed new generation. No React,
// no timers, no bridge: `advance(state, event)` is the only motion, and navigation is
// DERIVED from the state a transition produced ({@link runNavigation}), never computed
// in an effect that reads the state its own `navigate` mutates.
//
// The spike drove the whole loop off a `setInterval` clock (`run-view.tsx` counted to
// 10 100ms and fired `onReady`; `app/s/[slug]/run/page.tsx` then navigated from an
// effect and needed an `alreadyRanAtMount` ref to stop its own `router.replace` racing
// a `router.push`). That race is autopsy S9. Here the run is a machine: a folded
// `onProgress` payload (or a fixture tick) is a {@link RoundEvent}, the reducer walks
// the phases, and the route reads {@link runNavigation} off the resulting state. There
// is no effect that both mutates and reads the navigation target, so there is no race
// to guard.
// ─────────────────────────────────────────────────────────────────────────────

// The row/event vocabulary is the PROTOCOL's (C15 3.1): the daemon emits these events as a
// round really runs and this reducer folds them, so one definition serves both ends and the
// wire cannot drift from the machine. Re-exported here because every rounds surface reads
// them through the machine.
export type {
  GenerationCoverage,
  LaneRow,
  LaneVerdict,
  LensLane,
  RoundEvent,
  RowStatus,
} from "@rennet/protocol";

/**
 * The run machine's state — a discriminated union carrying ONLY what each phase
 * renders. `absent` is the honest default (no live round). The middle phases carry the
 * accumulated prep/worker rows; `reporting` onward carries the report board id; and
 * `composed` carries the new generation id the reveal navigates to. `failed` is
 * terminal and carries its reason. There is no stored progress fraction or navigation
 * target — both are DERIVED ({@link runProgressFraction}, {@link runNavigation}).
 */
type LegacyRoundState =
  | { readonly phase: "absent" }
  | { readonly phase: "dispatching" }
  | { readonly phase: "preparing"; readonly prep: readonly LaneRow[] }
  | {
      readonly phase: "working";
      readonly prep: readonly LaneRow[];
      readonly worker: readonly LaneRow[];
    }
  | {
      readonly phase: "gating";
      readonly prep: readonly LaneRow[];
      readonly worker: readonly LaneRow[];
    }
  | {
      readonly phase: "committing";
      readonly prep: readonly LaneRow[];
      readonly worker: readonly LaneRow[];
    }
  | {
      readonly phase: "reporting";
      readonly reportBoardId: string;
      readonly report?: RoundReportBoard;
    }
  | {
      readonly phase: "composing";
      readonly reportBoardId: string;
      readonly lanes: readonly LensLane[];
      /** The generation's cross-lens coverage state (#725 D4). It rides the same frame as
       *  the lanes and is rendered explicitly: coverage never gates a board's reveal, so
       *  the surface has to be able to say "pending" beside boards already on screen. */
      readonly coverage?: GenerationCoverage;
      readonly report?: RoundReportBoard;
    }
  | {
      readonly phase: "composed";
      /** The round's report board, when it drafted one. **Optional, and it matters:** a
       *  report drafter may honestly fail while real lens boards still compose. An empty
       *  coding checkpoint takes the separate `unchanged` terminal and never claims a
       *  composed generation. */
      readonly reportBoardId?: string;
      readonly report?: RoundReportBoard;
      readonly newGeneration: string;
      /** The lanes that were still on screen when the generation composed — carried
       *  through so the settled regeneration block does not blink out at the moment it
       *  finishes (C15 4.1/4.2: the kicker flips to "Regenerated the Boards" OVER the
       *  same rows). Optional: a `composed` reached without a preceding `lens` event
       *  (a round that composed nothing per-lens) honestly carries no lanes. */
      readonly lanes?: readonly LensLane[];
      readonly coverage?: GenerationCoverage;
    }
  | { readonly phase: "unchanged" }
  | { readonly phase: "failed"; readonly reason: string };

/** Operation identity and public run facts carried across every durable progress phase. */
export type RoundRunIdentity = Omit<RoundOperationProgressSnapshot, "state">;

interface DurableRoundRows {
  readonly operation: RoundRunIdentity;
  readonly prep: readonly LaneRow[];
  readonly worker: readonly LaneRow[];
  readonly tail: readonly LaneRow[];
}

interface DurableReportHandoff {
  readonly reportBoardId: string;
  readonly reportProgressRevision: number;
  readonly report?: RoundReportBoard;
}

type DurableRoundState =
  | (DurableRoundRows & {
      readonly phase:
        | "dispatching"
        | "preparing"
        | "working"
        | "gating"
        | "committing"
        | "drafting-report"
        | "verifying-report";
    })
  | (DurableRoundRows & {
      readonly phase: "reporting";
      readonly reportBoardId: string;
      readonly reportProgressRevision: number;
      readonly report?: RoundReportBoard;
    })
  | (DurableRoundRows & {
      readonly phase: "composing";
      readonly reportBoardId: string;
      readonly reportProgressRevision: number;
      readonly lanes: readonly LensLane[];
      readonly coverage?: GenerationCoverage;
      readonly report?: RoundReportBoard;
    })
  | (DurableRoundRows & {
      readonly phase: "verifying";
      readonly reportBoardId: string;
      readonly newGeneration: string;
      readonly reportProgressRevision?: number;
      readonly lanes?: readonly LensLane[];
      readonly coverage?: GenerationCoverage;
      readonly report?: RoundReportBoard;
    })
  | (DurableRoundRows & {
      readonly phase: "composed";
      readonly reportBoardId: string;
      readonly newGeneration: string;
      readonly reportProgressRevision?: number;
      readonly lanes?: readonly LensLane[];
      readonly coverage?: GenerationCoverage;
      readonly report?: RoundReportBoard;
    })
  | (DurableRoundRows & { readonly phase: "unchanged" })
  | (DurableRoundRows & {
      readonly phase: "failed";
      readonly reason: string;
      /** The report-drafting revision this failure can accept a scoped report from. */
      readonly reportAttemptRevision?: number;
      /** The verified report already handed to the board route before this failure. */
      readonly reportHandoff?: DurableReportHandoff;
    });

export type RoundState = LegacyRoundState | DurableRoundState;

/** The phase discriminants, in progress order. */
export type RoundPhase = RoundState["phase"];

/** The honest-absent starting state — no round, nothing to render. */
export const initialRoundState: RoundState = { phase: "absent" };

function operationIdentity(snapshot: RoundOperationProgressSnapshot): RoundRunIdentity {
  return {
    operationId: snapshot.operationId,
    revision: snapshot.revision,
    ...(snapshot.rerunRequested === undefined ? {} : { rerunRequested: snapshot.rerunRequested }),
    createdAt: snapshot.createdAt,
    roundNumber: snapshot.roundNumber,
    sourceTarget: snapshot.sourceTarget,
    askCount: snapshot.askCount,
    gatePlan: snapshot.gatePlan,
  };
}

export function roundTargetLabel(target: RoundRunIdentity["sourceTarget"]): string {
  return target.kind === "branch" ? target.branch : `detached at ${target.head.slice(0, 12)}`;
}

/** The status register a coverage row renders in. `warn` is not a `RowStatus`: it is the
 *  copper caution register, and it exists here because a coverage run that COMPLETED with
 *  uncovered hunks is neither a failure to fix nor a clean result — a green check over
 *  "3 hunks uncovered" reads as done and says the opposite of what the text beside it does. */
export type CoverageStatus = "running" | "done" | "failed" | "warn";

export function coverageStatus(coverage: GenerationCoverage): CoverageStatus {
  switch (coverage.state) {
    case "pending":
      return "running";
    case "failed":
      return "failed";
    case "complete":
      return coverage.violations === 0 ? "done" : "warn";
  }
}

/**
 * The reviewer-facing sentence for one cross-lens coverage state (#725 D4). ONE helper for
 * both surfaces that render it — the round greeting and the initial generation's
 * preparation screen — because two copies of a user-visible sentence drift, and coverage
 * is the same fact whichever screen is asking.
 *
 * Coverage ANNOTATES the boards already on screen: it never gates their reveal and never
 * rewrites one, so `pending` has to be sayable beside settled lanes rather than
 * represented by hiding them.
 */
export function coverageNote(coverage: GenerationCoverage): string {
  switch (coverage.state) {
    case "pending":
      return "Cross-lens coverage · still running";
    case "complete":
      return coverage.violations === 0
        ? "Cross-lens coverage · every hunk covered"
        : `Cross-lens coverage · ${coverage.violations} hunk${coverage.violations === 1 ? "" : "s"} uncovered`;
    case "failed":
      return `Cross-lens coverage · could not be computed — ${coverage.reason}`;
  }
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function durationLabel(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs} ms`;
  const seconds = durationMs / 1_000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
}

function preparedRows(operation: RoundRunIdentity, asks: "running" | "done"): readonly LaneRow[] {
  return [
    {
      id: "worktree",
      label: "Created detached worktree",
      status: "done",
      detail: `${roundTargetLabel(operation.sourceTarget)} @ round-${operation.roundNumber}`,
    },
    asks === "running"
      ? { id: "asks", label: "Applying the round's asks", status: "running" }
      : {
          id: "asks",
          label: "Applied the round's asks",
          status: "done",
          detail: countLabel(operation.askCount, "ask"),
        },
  ];
}

function settledWorkerRow(fileCount: number): LaneRow {
  return {
    id: "worker",
    label: "Ran the round worker",
    status: "done",
    detail: countLabel(fileCount, "file changed", "files changed"),
  };
}

function gateCommand(operation: RoundRunIdentity): string {
  return operation.gatePlan.kind === "configured"
    ? operation.gatePlan.command
    : "no configured gate";
}

type ProgressState = RoundOperationProgressSnapshot["state"];
type PropertyValues<T, Key extends PropertyKey> = T extends unknown
  ? Key extends keyof T
    ? T[Key]
    : never
  : never;
type ProgressFailure = PropertyValues<ProgressState, "failure">;
type GateProgress = PropertyValues<ProgressState, "gate"> | PropertyValues<ProgressFailure, "gate">;
type SettledGateProgress = Exclude<GateProgress, { status: "running" | "failed" }>;

function gateRow(operation: RoundRunIdentity, gate: GateProgress): LaneRow {
  const command = gateCommand(operation);
  switch (gate.status) {
    case "running":
      return { id: "gate", label: `Running the gate · ${command}`, status: "running" };
    case "passed": {
      const projectResult =
        gate.projectCount === undefined
          ? "passed"
          : `${countLabel(gate.projectCount, "project")} green`;
      return {
        id: "gate",
        label: "Ran the gate",
        status: "done",
        detail: `${command} · ${projectResult} · ${durationLabel(gate.durationMs)}`,
      };
    }
    case "skipped":
      return {
        id: "gate",
        label: "Skipped the gate",
        status: "done",
        detail: "not configured",
      };
    case "failed":
      return {
        id: "gate",
        label: "Ran the gate",
        status: "failed",
        reason: `${command}${
          gate.projectCount === undefined ? "" : ` · ${countLabel(gate.projectCount, "project")}`
        } · ${gate.reason} · ${durationLabel(gate.durationMs)}`,
      };
  }
}

function settledGateRow(operation: RoundRunIdentity, gate: SettledGateProgress): LaneRow {
  return gateRow(operation, gate);
}

function commitRow(
  commit:
    | { readonly status: "running" }
    | { readonly status: "done"; readonly count: number }
    | { readonly status: "failed"; readonly reason: string },
): LaneRow {
  switch (commit.status) {
    case "running":
      return { id: "commit", label: "Recording round commits", status: "running" };
    case "done":
      return {
        id: "commit",
        label: "Recorded round commits",
        status: "done",
        detail: countLabel(commit.count, "commit"),
      };
    case "failed":
      return {
        id: "commit",
        label: "Recording round commits",
        status: "failed",
        reason: commit.reason,
      };
  }
}

type ProgressResult = PropertyValues<ProgressState, "result">;
type ChangedProgressResult = Extract<ProgressResult, { kind: "changed" }>;
type ReportProgress =
  | PropertyValues<ProgressState, "report">
  | PropertyValues<ProgressFailure, "report">
  | PropertyValues<ChangedProgressResult, "report">;

/** The report's SETTLED row. The round report is done the moment it is handed off (#728);
 *  everything after that boundary is lens work and must not wear the report's label. */
const DRAFTED_REPORT_ROW: LaneRow = {
  id: "report",
  label: "Drafted the round report",
  status: "done",
  detail: "handed off to the lens drafters",
};

/** Replace a running report row with its settled one, leaving every other row alone. */
function withSettledReportRow(tail: readonly LaneRow[]): readonly LaneRow[] {
  return tail.map((row) => (row.id === "report" ? DRAFTED_REPORT_ROW : row));
}

function reportRow(report: ReportProgress): LaneRow {
  switch (report.status) {
    case "drafting":
      return { id: "report", label: "Drafting the round report", status: "running" };
    case "handed-off":
      return DRAFTED_REPORT_ROW;
    case "verifying":
      return { id: "report", label: "Verifying the round report", status: "running" };
    case "verified":
      return {
        id: "report",
        label: "Drafted the round report",
        status: "done",
        detail: "verified against the round's diff",
      };
    case "failed":
      return {
        id: "report",
        label:
          report.step === "drafting" ? "Drafting the round report" : "Verifying the round report",
        status: "failed",
        reason: report.reason,
      };
  }
}

function durableState(snapshot: RoundOperationProgressSnapshot): DurableRoundState {
  const operation = operationIdentity(snapshot);
  const donePrep = preparedRows(operation, "done");
  const state = snapshot.state;
  switch (state.phase) {
    case "claimed":
      return { phase: "dispatching", operation, prep: [], worker: [], tail: [] };
    case "workspace-preparing":
      return {
        phase: "preparing",
        operation,
        prep: [{ id: "worktree", label: "Creating detached worktree", status: "running" }],
        worker: [],
        tail: [],
      };
    case "prepared":
      return {
        phase: "preparing",
        operation,
        prep: preparedRows(operation, "running"),
        worker: [],
        tail: [],
      };
    case "worker-running":
      return {
        phase: "working",
        operation,
        prep: donePrep,
        worker: [{ id: "worker", label: "Round worker", status: "running" }],
        tail: [],
      };
    case "worker-settled":
      return {
        phase: "working",
        operation,
        prep: donePrep,
        worker: [settledWorkerRow(state.worker.fileCount)],
        tail: [],
      };
    case "gate-running":
      return {
        phase: "gating",
        operation,
        prep: donePrep,
        worker: [settledWorkerRow(state.worker.fileCount)],
        tail: [gateRow(operation, state.gate)],
      };
    case "gate-settled":
      return {
        phase: "gating",
        operation,
        prep: donePrep,
        worker: [settledWorkerRow(state.worker.fileCount)],
        tail: [settledGateRow(operation, state.gate)],
      };
    case "committing":
      return {
        phase: "committing",
        operation,
        prep: donePrep,
        worker: [settledWorkerRow(state.worker.fileCount)],
        tail: [settledGateRow(operation, state.gate), commitRow(state.commits)],
      };
    case "commits-settled":
      return {
        phase: "committing",
        operation,
        prep: donePrep,
        worker: [settledWorkerRow(state.worker.fileCount)],
        tail: [settledGateRow(operation, state.gate), commitRow(state.commits)],
      };
    case "report-drafting": {
      const tail = [
        settledGateRow(operation, state.gate),
        commitRow(state.commits),
        reportRow(state.report),
      ];
      // #725 7.4 — the durable operation has no phase of its own for the lens fan-out, so
      // it stays in `report-drafting` throughout it. The handoff is what distinguishes
      // them: before it, the report seat is running; after it, the lens drafters are, and
      // a reconnecting client must land on the lens phase rather than on a report row that
      // finished minutes ago.
      if (state.report.status === "handed-off") {
        return {
          phase: "reporting",
          operation,
          prep: donePrep,
          worker: [settledWorkerRow(state.worker.fileCount)],
          tail,
          reportBoardId: state.report.reportBoardId,
          reportProgressRevision: operation.revision,
        };
      }
      return {
        phase: "drafting-report",
        operation,
        prep: donePrep,
        worker: [settledWorkerRow(state.worker.fileCount)],
        tail,
      };
    }
    case "report-verifying":
      if (!("reportBoardId" in state.report)) {
        return {
          phase: "verifying-report",
          operation,
          prep: donePrep,
          worker: [settledWorkerRow(state.worker.fileCount)],
          tail: [
            settledGateRow(operation, state.gate),
            commitRow(state.commits),
            reportRow(state.report),
          ],
        };
      }
      return {
        phase: "verifying",
        operation,
        prep: donePrep,
        worker: [settledWorkerRow(state.worker.fileCount)],
        tail: [
          settledGateRow(operation, state.gate),
          commitRow(state.commits),
          reportRow(state.report),
        ],
        reportBoardId: state.report.reportBoardId,
        newGeneration: state.report.generation,
      };
    case "completed": {
      if (snapshot.rerunRequested === true) {
        return { phase: "dispatching", operation, prep: [], worker: [], tail: [] };
      }
      const rows = {
        operation,
        prep: donePrep,
        worker: [settledWorkerRow(state.worker.fileCount)],
        tail: [settledGateRow(operation, state.gate), commitRow(state.commits)],
      };
      if (snapshot.draining === true) {
        if (state.result.kind === "unchanged") return { phase: "committing", ...rows };
        return {
          phase: "verifying",
          ...rows,
          tail: [...rows.tail, reportRow(state.result.report)],
          reportBoardId: state.result.report.reportBoardId,
          newGeneration: state.result.report.generation,
        };
      }
      if (state.result.kind === "unchanged") return { phase: "unchanged", ...rows };
      return {
        phase: "composed",
        ...rows,
        tail: [...rows.tail, reportRow(state.result.report)],
        reportBoardId: state.result.report.reportBoardId,
        newGeneration: state.result.report.generation,
      };
    }
    case "failed": {
      const failure = state.failure;
      switch (failure.at) {
        case "preparing":
          return {
            phase: "failed",
            operation,
            reason: failure.workspace.reason,
            prep: [
              {
                id: "worktree",
                label: "Creating detached worktree",
                status: "failed",
                reason: failure.workspace.reason,
              },
            ],
            worker: [],
            tail: [],
          };
        case "worker":
          return {
            phase: "failed",
            operation,
            reason: failure.worker.reason,
            prep: donePrep,
            worker: [
              {
                id: "worker",
                label: "Round worker",
                status: "failed",
                reason: failure.worker.reason,
              },
            ],
            tail: [],
          };
        case "gate":
          return {
            phase: "failed",
            operation,
            reason: failure.gate.reason,
            prep: donePrep,
            worker: [settledWorkerRow(failure.worker.fileCount)],
            tail: [gateRow(operation, failure.gate)],
          };
        case "committing":
          return {
            phase: "failed",
            operation,
            reason: failure.commits.reason,
            prep: donePrep,
            worker: [settledWorkerRow(failure.worker.fileCount)],
            tail: [settledGateRow(operation, failure.gate), commitRow(failure.commits)],
          };
        case "report-drafting":
        case "report-verifying":
          return {
            phase: "failed",
            operation,
            reason: failure.report.reason,
            prep: donePrep,
            worker: [settledWorkerRow(failure.worker.fileCount)],
            tail: [
              settledGateRow(operation, failure.gate),
              commitRow(failure.commits),
              reportRow(failure.report),
            ],
          };
      }
    }
  }
}

function isNewerOperation(
  candidate: RoundOperationProgressSnapshot,
  current: RoundRunIdentity,
): boolean {
  if (candidate.createdAt !== current.createdAt) return candidate.createdAt > current.createdAt;
  if (candidate.operationId !== current.operationId) {
    return candidate.operationId.localeCompare(current.operationId) > 0;
  }
  return candidate.revision > current.revision;
}

function reportHandoffFromState(state: RoundState): DurableReportHandoff | undefined {
  if (!("operation" in state)) return undefined;
  if (state.phase === "failed") return state.reportHandoff;
  if (!("reportBoardId" in state) || state.reportBoardId === undefined) return undefined;
  if (!("reportProgressRevision" in state) || state.reportProgressRevision === undefined) {
    return undefined;
  }
  return {
    reportBoardId: state.reportBoardId,
    reportProgressRevision: state.reportProgressRevision,
    ...(state.report === undefined ? {} : { report: state.report }),
  };
}

function reportAttemptRevisionFromState(state: RoundState): number | undefined {
  if (!("operation" in state)) return undefined;
  if (state.phase === "failed") return state.reportAttemptRevision;
  if (state.phase === "drafting-report") return state.operation.revision;
  return "reportProgressRevision" in state ? state.reportProgressRevision : undefined;
}

/**
 * The pure transition. Forward-only and tolerant: an event that does not apply to the
 * current phase returns the state unchanged (progress channels can duplicate or
 * re-order, and the machine is a trust boundary). The two TERMINAL events — `failed` and
 * `composed` — apply from ANY in-flight phase, so a round that ends is always able to say
 * so; from a terminal or absent state both are ignored, so a settled round never
 * un-settles.
 */
export function advance(state: RoundState, event: RoundEvent): RoundState {
  if (event.type === "operation") {
    if ("operation" in state && !isNewerOperation(event.snapshot, state.operation)) return state;
    const next = durableState(event.snapshot);
    if (
      next.phase === "failed" &&
      "operation" in state &&
      state.operation.operationId === event.snapshot.operationId
    ) {
      const reportHandoff = reportHandoffFromState(state);
      const reportAttemptRevision = reportAttemptRevisionFromState(state);
      return {
        ...next,
        ...(reportAttemptRevision === undefined ? {} : { reportAttemptRevision }),
        ...(reportHandoff === undefined ? {} : { reportHandoff }),
      };
    }
    if (
      "operation" in state &&
      state.operation.operationId === event.snapshot.operationId &&
      (next.phase === "verifying" || next.phase === "composed") &&
      (state.phase === "composing" || state.phase === "verifying")
    ) {
      return {
        ...next,
        ...("reportProgressRevision" in state && state.reportProgressRevision !== undefined
          ? { reportProgressRevision: state.reportProgressRevision }
          : {}),
        ...(state.lanes === undefined ? {} : { lanes: state.lanes }),
        ...(state.coverage === undefined ? {} : { coverage: state.coverage }),
        ...(state.report === undefined ? {} : { report: state.report }),
      };
    }
    return next;
  }
  // A durable operation owns its report/lens progress. These two scoped snapshots are
  // allowed to refine `report-drafting`; every unscoped legacy delta remains ignored.
  if ("operation" in state) {
    if (event.type !== "report" && event.type !== "lens") return state;
    if (event.operationId !== state.operation.operationId) return state;
    if (event.operationRevision === undefined) return state;
    if (
      event.type === "report" &&
      state.phase === "drafting-report" &&
      (event.operationRevision === state.operation.revision ||
        (state.operation.rerunRequested === true &&
          event.operationRevision < state.operation.revision))
    ) {
      return {
        ...state,
        phase: "reporting",
        // The report has landed and been handed off; the lens drafters are what runs from
        // here. Leaving its row spinning would file the whole lens fan-out under the
        // report's label (#725 7.4).
        tail: withSettledReportRow(state.tail),
        reportBoardId: event.reportBoardId,
        reportProgressRevision: event.operationRevision,
        ...(event.report === undefined ? {} : { report: event.report }),
      };
    }
    if (
      event.type === "report" &&
      state.phase === "failed" &&
      event.operationRevision === state.reportAttemptRevision &&
      (state.reportHandoff === undefined ||
        state.reportHandoff.reportBoardId === event.reportBoardId)
    ) {
      return {
        ...state,
        reportHandoff: {
          reportBoardId: event.reportBoardId,
          reportProgressRevision: event.operationRevision,
          ...(event.report === undefined ? {} : { report: event.report }),
        },
      };
    }
    if (
      event.type === "report" &&
      state.phase === "reporting" &&
      event.reportBoardId === state.reportBoardId &&
      event.report !== undefined
    ) {
      // A client that reconnected mid-fan-out derived `reporting` from the durable
      // snapshot, which carries the report's identity but not its content. The scoped
      // event carries the projection; take it without re-opening the phase.
      return { ...state, report: event.report, reportProgressRevision: event.operationRevision };
    }
    if (
      event.type === "report" &&
      (state.phase === "verifying" || state.phase === "composed") &&
      event.reportBoardId === state.reportBoardId
    ) {
      return event.report === undefined
        ? state
        : {
            ...state,
            report: event.report,
            reportProgressRevision: event.operationRevision,
          };
    }
    if (event.type === "lens") {
      // The coverage state rides the lane frame. It is only ever REPLACED by a newer
      // frame's state, never cleared by one that carries none: a daemon that emits no
      // coverage (or an older one) leaves the last honest state standing rather than
      // silently reverting the surface to "no coverage reported".
      const coverage = event.coverage === undefined ? {} : { coverage: event.coverage };
      if (state.phase === "reporting" && event.operationRevision === state.reportProgressRevision) {
        return {
          ...state,
          phase: "composing",
          reportBoardId: state.reportBoardId,
          lanes: event.lanes,
          ...coverage,
        };
      }
      if (state.phase === "composing" && event.operationRevision === state.reportProgressRevision) {
        return { ...state, lanes: event.lanes, ...coverage };
      }
      if (
        (state.phase === "verifying" || state.phase === "composed") &&
        state.reportProgressRevision === event.operationRevision
      ) {
        return { ...state, lanes: event.lanes, ...coverage };
      }
    }
    return state;
  }
  if (event.type === "unchanged") {
    return state.phase === "absent" ||
      state.phase === "composed" ||
      state.phase === "unchanged" ||
      state.phase === "failed"
      ? state
      : { phase: "unchanged" };
  }
  if (event.type === "failed") {
    return state.phase === "absent" ||
      state.phase === "composed" ||
      state.phase === "unchanged" ||
      state.phase === "failed"
      ? state
      : { phase: "failed", reason: event.reason };
  }
  // `composed` is terminal from ANY in-flight phase, for the same reason `failed` is: it
  // is the round's own account of having finished, and a machine that can only accept it
  // from one predecessor phase turns a missing intermediate event into a permanent stall.
  // The intermediate that goes missing in practice is `report` — a round with no successor
  // account never runs the report seat — and the run view then sat at `committing`
  // forever, ignoring the lens events and the composed generation behind it, showing a
  // live-looking round that had already ended.
  if (event.type === "composed") {
    if (state.phase === "absent" || state.phase === "composed" || state.phase === "failed") {
      return state;
    }
    const reportBoardId = "reportBoardId" in state ? state.reportBoardId : undefined;
    const report = "report" in state ? state.report : undefined;
    const lanes = state.phase === "composing" ? state.lanes : undefined;
    const coverage = "coverage" in state ? state.coverage : undefined;
    return {
      phase: "composed",
      newGeneration: event.generation,
      ...(reportBoardId === undefined ? {} : { reportBoardId }),
      ...(report === undefined ? {} : { report }),
      ...(lanes === undefined ? {} : { lanes }),
      ...(coverage === undefined ? {} : { coverage }),
    };
  }
  switch (state.phase) {
    case "absent":
      return event.type === "dispatched" ? { phase: "dispatching" } : state;
    case "dispatching":
      return event.type === "prep" ? { phase: "preparing", prep: event.rows } : state;
    case "preparing":
      if (event.type === "prep") return { phase: "preparing", prep: event.rows };
      if (event.type === "worker")
        return { phase: "working", prep: state.prep, worker: event.rows };
      return state;
    case "working":
      if (event.type === "worker")
        return { phase: "working", prep: state.prep, worker: event.rows };
      if (event.type === "gate") return { phase: "gating", prep: state.prep, worker: state.worker };
      return state;
    case "gating":
      return event.type === "committed"
        ? { phase: "committing", prep: state.prep, worker: state.worker }
        : state;
    case "committing":
      return event.type === "report"
        ? {
            phase: "reporting",
            reportBoardId: event.reportBoardId,
            ...(event.report === undefined ? {} : { report: event.report }),
          }
        : state;
    case "reporting":
      return event.type === "lens"
        ? {
            phase: "composing",
            reportBoardId: state.reportBoardId,
            lanes: event.lanes,
            ...(event.coverage === undefined ? {} : { coverage: event.coverage }),
            ...(state.report === undefined ? {} : { report: state.report }),
          }
        : state;
    case "composing":
      return event.type === "lens"
        ? {
            ...state,
            lanes: event.lanes,
            ...(event.coverage === undefined ? {} : { coverage: event.coverage }),
          }
        : state;
    case "composed":
    case "unchanged":
    case "failed":
      return state; // terminal
  }
}

function latestScopedEvent<T extends { readonly seq?: number }>(
  events: readonly T[],
): T | undefined {
  let latest: T | undefined;
  for (const event of events) {
    if (event.seq === undefined) continue;
    if (latest?.seq === undefined || event.seq > latest.seq) latest = event;
  }
  // A legacy daemon gives every candidate no sequence. Only then is transport arrival
  // order the best available account; mixed logs prefer the monotonic server sequence.
  return latest ?? events.at(-1);
}

function latestScopedAttemptEvent<
  T extends { readonly operationRevision?: number; readonly seq?: number },
>(events: readonly T[]): T | undefined {
  let latestRevision: number | undefined;
  for (const event of events) {
    if (event.operationRevision === undefined) continue;
    if (latestRevision === undefined || event.operationRevision > latestRevision) {
      latestRevision = event.operationRevision;
    }
  }
  if (latestRevision === undefined) return undefined;
  return latestScopedEvent(events.filter((event) => event.operationRevision === latestRevision));
}

/**
 * Merge a catch-up read's events with the ones the live channel pushed, by the monotonic
 * `seq` the emitting hub stamps on each (review finding 7).
 *
 * Two writers feed one log and neither is authoritative alone: the read answers with the
 * daemon's log as of the moment it was served, and the push carries whatever happened
 * since — so installing the read's answer over the folded stream DROPS every event that
 * landed during the flight, and a dropped terminal event leaves the surface reading
 * "still working" over a round that finished. Merging by `seq` makes the two orders one:
 * an event already held is recognised and ignored, and the result is the union in the
 * order the daemon emitted it, never the order the transports happened to deliver it.
 *
 * A `dispatched` STARTS a round (the daemon's hub clears its log on one), so everything
 * before the NEWEST `dispatched` belongs to a round that is over and is dropped. That is
 * what stops a late terminal event from the previous round settling the round now running,
 * and it holds with or without a `seq` — it is a rule about the log, not about the ordering.
 *
 * Events with no `seq` come from a daemon that predates it — they cannot be ordered, so
 * they are kept in arrival order and never deduped. The honest degrade, not a handshake.
 */
export function mergeRoundEvents(
  read: readonly RoundEvent[],
  streamed: readonly RoundEvent[],
): readonly RoundEvent[] {
  const all = [...read, ...streamed];
  let latestOperation: Extract<RoundEvent, { type: "operation" }> | undefined;
  for (const event of all) {
    if (event.type !== "operation") continue;
    if (
      latestOperation === undefined ||
      isNewerOperation(event.snapshot, operationIdentity(latestOperation.snapshot))
    ) {
      latestOperation = event;
    }
  }
  // The operation snapshot stays authoritative. Once report drafting begins, retain the
  // latest operation-scoped report and lens snapshots beside it: they expose a report only
  // after the server verified its durable read-back, and can never mark completion.
  if (latestOperation !== undefined) {
    const state = latestOperation.snapshot.state;
    const carriesReportProgress =
      state.phase === "report-drafting" ||
      state.phase === "report-verifying" ||
      (state.phase === "failed" &&
        (state.failure.at === "report-drafting" || state.failure.at === "report-verifying")) ||
      (state.phase === "completed" && state.result.kind === "changed");
    if (!carriesReportProgress) return [latestOperation];
    const operationId = latestOperation.snapshot.operationId;
    if (state.phase === "failed") {
      // Queueing the next round advances the operation CAS revision without changing this
      // round's durable handoff. In that one case, the report's paired drafting revision
      // identifies the attempt; a real retry still requires the newest drafting revision.
      if (latestOperation.snapshot.rerunRequested === true) {
        const reportRevisions = new Set<number>();
        for (const event of all) {
          if (
            event.type === "report" &&
            event.operationId === operationId &&
            event.operationRevision !== undefined &&
            event.operationRevision <= latestOperation.snapshot.revision
          ) {
            reportRevisions.add(event.operationRevision);
          }
        }
        for (const reportRevision of [...reportRevisions].sort((a, b) => b - a)) {
          const reportAttempt = latestScopedEvent(
            all.filter(
              (event): event is Extract<RoundEvent, { type: "operation" }> =>
                event.type === "operation" &&
                event.snapshot.operationId === operationId &&
                event.snapshot.revision === reportRevision &&
                event.snapshot.state.phase === "report-drafting",
            ),
          );
          if (reportAttempt === undefined) continue;
          const report = latestScopedEvent(
            all.filter(
              (event): event is Extract<RoundEvent, { type: "report" }> =>
                event.type === "report" &&
                event.operationId === operationId &&
                event.operationRevision === reportRevision,
            ),
          );
          if (report !== undefined) return [reportAttempt, latestOperation, report];
        }
        return [latestOperation];
      }
      let reportAttempt: Extract<RoundEvent, { type: "operation" }> | undefined;
      for (const event of all) {
        if (
          event.type !== "operation" ||
          event.snapshot.operationId !== operationId ||
          event.snapshot.revision > latestOperation.snapshot.revision ||
          event.snapshot.state.phase !== "report-drafting"
        ) {
          continue;
        }
        if (
          reportAttempt === undefined ||
          event.snapshot.revision > reportAttempt.snapshot.revision
        ) {
          reportAttempt = event;
        }
      }
      if (reportAttempt === undefined) return [latestOperation];
      const report = latestScopedEvent(
        all.filter(
          (event): event is Extract<RoundEvent, { type: "report" }> =>
            event.type === "report" &&
            event.operationId === operationId &&
            event.operationRevision === reportAttempt.snapshot.revision,
        ),
      );
      return report === undefined ? [latestOperation] : [reportAttempt, latestOperation, report];
    }
    const report = latestScopedAttemptEvent(
      all.filter(
        (event): event is Extract<RoundEvent, { type: "report" }> =>
          event.type === "report" &&
          event.operationId === operationId &&
          event.operationRevision !== undefined &&
          event.operationRevision <= latestOperation.snapshot.revision &&
          (state.phase !== "report-drafting" ||
            event.operationRevision === latestOperation.snapshot.revision ||
            latestOperation.snapshot.rerunRequested === true),
      ),
    );
    if (report === undefined) return [latestOperation];
    const reportRevision = report.operationRevision;
    const retainedReportAttempt =
      state.phase === "report-drafting" &&
      latestOperation.snapshot.rerunRequested === true &&
      reportRevision !== undefined &&
      reportRevision < latestOperation.snapshot.revision
        ? latestScopedEvent(
            all.filter(
              (event): event is Extract<RoundEvent, { type: "operation" }> =>
                event.type === "operation" &&
                event.snapshot.operationId === operationId &&
                event.snapshot.revision === reportRevision &&
                event.snapshot.state.phase === "report-drafting",
            ),
          )
        : undefined;
    const acceptsLensRevision =
      state.phase !== "report-drafting" ||
      reportRevision === latestOperation.snapshot.revision ||
      (latestOperation.snapshot.rerunRequested === true &&
        reportRevision === latestOperation.snapshot.revision - 1);
    const lens = acceptsLensRevision
      ? latestScopedEvent(
          all.filter(
            (event): event is Extract<RoundEvent, { type: "lens" }> =>
              event.type === "lens" &&
              event.operationId === operationId &&
              event.operationRevision === report.operationRevision,
          ),
        )
      : undefined;
    const progress =
      lens === undefined ? [latestOperation, report] : [latestOperation, report, lens];
    return retainedReportAttempt === undefined ? progress : [retainedReportAttempt, ...progress];
  }

  const bySeq = new Map<number, RoundEvent>();
  const unsequenced: RoundEvent[] = [];
  for (const event of all) {
    if (event.seq === undefined) unsequenced.push(event);
    else if (!bySeq.has(event.seq)) bySeq.set(event.seq, event);
  }
  const ordered: RoundEvent[] = [];
  for (const position of [...bySeq.keys()].sort((a, b) => a - b)) {
    const event = bySeq.get(position);
    if (event !== undefined) ordered.push(event);
  }
  const merged = [...unsequenced, ...ordered];
  const start = merged.findLastIndex((event) => event.type === "dispatched");
  return start > 0 ? merged.slice(start) : merged;
}

// ── Derived reads (the route/greeting read these; they never live in an effect) ──

/**
 * True ONLY at `composed` — the single gate for **View the New Boards** (C09 §5). The
 * control is rendered iff this is true; it is never a disabled button waiting to enable
 * (packet + INVENTORY §7.2), because "can reveal" is derived from the machine reaching
 * composition, not from an effect flipping a flag.
 */
export const canRevealNewBoards = (state: RoundState): boolean => state.phase === "composed";

const PHASE_ORDER: readonly RoundPhase[] = [
  "absent",
  "dispatching",
  "preparing",
  "working",
  "gating",
  "committing",
  "drafting-report",
  "reporting",
  "composing",
  "verifying-report",
  "verifying",
  "composed",
];

/** A coarse 0..1 progress fraction, DERIVED from the phase's position in the run — not
 *  a stored count. `failed` reads as complete (the run stopped). */
export function runProgressFraction(state: RoundState): number {
  if (state.phase === "failed" || state.phase === "unchanged") return 1;
  return PHASE_ORDER.indexOf(state.phase) / (PHASE_ORDER.length - 1);
}

/**
 * The navigation a transition implies — the S9 fence's replacement for effect-driven
 * routing. The run route READS this off the current state and navigates when it is
 * non-null; it never computes a target inside an effect that reads the state its own
 * navigate changes.
 *
 * - `absent` (a cold `/s/:slug/run` deep-link with no live round) ⇒ redirect to the
 *   session board (replace — the run route leaves no back-stack entry).
 * - a report-bearing `reporting` / `composing` / `verifying` state ⇒ hand the readable
 *   report to the board surface while regeneration/final verification continues;
 * - `composed` / `unchanged` ⇒ the terminal handoff (Reveal still requires `composed`);
 * - every earlier in-flight phase and `failed` ⇒ `null`: stay on the run route.
 */
export function runNavigation(state: RoundState, slug: string): Navigation | null {
  switch (state.phase) {
    case "absent":
    case "composing":
    case "verifying":
    case "composed":
    case "unchanged":
      return { path: sessionPath(slug, { view: "board" }), replace: true };
    case "reporting":
      return state.reportBoardId === undefined
        ? null
        : { path: sessionPath(slug, { view: "board" }), replace: true };
    default:
      return null;
  }
}
