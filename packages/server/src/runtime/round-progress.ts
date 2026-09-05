import {
  type RoundEvent,
  type RoundOperation,
  type RoundReportHandoff,
  roundOperationProgressSnapshot,
} from "@rennet/protocol";

// ─────────────────────────────────────────────────────────────────────────────
// The live round-progress hub (C15 3.1) — the server half of the channel that replaces
// the client's fixture timeline with a real feed.
//
// It is an APPEND-ONLY EVENT LOG per review, not a state machine. The machine lives on
// the client (`app-ui/src/rounds/round-machine.ts`), and it is a pure fold; keeping the
// server as the log means the two ends cannot disagree about a phase, and a client that
// joins late (a cold `/s/:slug/run` deep-link, or a reconnect mid-round) catches up by
// folding the same events the live subscriber folded — one reducer, one truth.
//
// Keyed by REVIEW id, because a slug IS a review id (`routes/slug.ts`): the run route
// subscribes with the id it already holds, and no session-id translation sits between the
// reviewer's URL and their round.
// ─────────────────────────────────────────────────────────────────────────────

/** How many events one review's round log retains. A round emits on the order of a
 *  dozen events; the cap only stops a pathological emitter growing without bound, and
 *  it drops the OLDEST first so the current phase always survives. */
const MAX_EVENTS_PER_REVIEW = 200;

function reportHandoffForOperation(operation: RoundOperation): RoundReportHandoff | undefined {
  const state = operation.state;
  if (state.phase === "report-drafting" || state.phase === "report-verifying") {
    return state.report.handoff;
  }
  if (state.phase === "completed" && state.result.kind === "changed") {
    return state.result.report.handoff;
  }
  if (
    state.phase === "failed" &&
    (state.failure.at === "report-drafting" || state.failure.at === "report-verifying")
  ) {
    return state.failure.report.handoff;
  }
  return undefined;
}

/** Rebuild the exact report handoff from the durable operation after a daemon restart.
 * The caller revalidates the board metadata before allowing the stored projection onto
 * the wire. A failed operation also carries its report-attempt snapshot because the
 * client needs that exact revision to reject reports from an earlier retry. */
export function roundEventsForDurableOperation(input: {
  readonly operation: RoundOperation;
  readonly liveEvents: readonly RoundEvent[];
  readonly reportHandoffIsReadable: (handoff: RoundReportHandoff) => boolean;
}): readonly RoundEvent[] {
  const { operation } = input;
  const current: RoundEvent = {
    type: "operation",
    snapshot: roundOperationProgressSnapshot(operation),
  };
  const live = input.liveEvents.filter(
    (event) =>
      (event.type === "report" || event.type === "lens" || event.type === "report-diagnostic") &&
      event.operationId === operation.operationId,
  );
  const diagnostics = live.filter((event) => event.type === "report-diagnostic");
  const handoff = reportHandoffForOperation(operation);
  if (
    handoff === undefined ||
    handoff.operationId !== operation.operationId ||
    handoff.operationRevision > operation.revision ||
    !input.reportHandoffIsReadable(handoff)
  ) {
    return [current, ...diagnostics];
  }
  const liveHasReport = live.some(
    (event) =>
      event.type === "report" &&
      event.operationRevision === handoff.operationRevision &&
      event.reportBoardId === handoff.reportBoardId,
  );
  const report: RoundEvent = {
    type: "report",
    operationId: handoff.operationId,
    operationRevision: handoff.operationRevision,
    reportBoardId: handoff.reportBoardId,
    report: handoff.report,
  };
  if (operation.state.phase !== "failed") {
    return [current, ...(liveHasReport ? [] : [report]), ...live];
  }
  const failure = operation.state.failure;
  if (
    (failure.at !== "report-drafting" && failure.at !== "report-verifying") ||
    handoff.operationRevision >= operation.revision
  ) {
    return [current, ...live];
  }
  const reportAttempt: RoundOperation = {
    ...operation,
    revision: handoff.operationRevision,
    state: {
      phase: "report-drafting",
      workspace: failure.workspace,
      worker: failure.worker,
      commits: failure.commits,
      recording: failure.recording,
      report: failure.report,
    },
  };
  return [
    { type: "operation", snapshot: roundOperationProgressSnapshot(reportAttempt) },
    current,
    ...(liveHasReport ? [] : [report]),
    ...live,
  ];
}

export class RoundProgressHub {
  readonly #logs = new Map<string, RoundEvent[]>();
  /** The next `seq` per review — MONOTONIC ACROSS ROUNDS, never reset by a `dispatched`.
   *  That is the whole point: the client merges the catch-up read with the live push by
   *  this number, and a round-1 event whose seq predates round 2's `dispatched` is
   *  recognisable as belonging to a finished round instead of settling the running one. */
  readonly #nextSeq = new Map<string, number>();
  readonly #broadcast: ((reviewId: string, event: RoundEvent) => void) | undefined;

  /** @param broadcast the live push sink (the WS listener's fan-out). Absent ⇒ the hub
   *  still records, so the `session.roundEvents` read is answerable with no live socket. */
  constructor(broadcast?: (reviewId: string, event: RoundEvent) => void) {
    this.#broadcast = broadcast;
  }

  /**
   * Record one real progress event and push it live. A `dispatched` event STARTS a round,
   * so it clears the prior round's log — the run route folds one round at a time, and a
   * second dispatch must not replay the first round's composed state.
   */
  emit(reviewId: string, event: RoundEvent): void {
    const seq = this.#nextSeq.get(reviewId) ?? 0;
    this.#nextSeq.set(reviewId, seq + 1);
    const sequenced: RoundEvent = { ...event, seq };
    const log =
      event.type === "dispatched" || (event.type === "operation" && event.snapshot.revision === 0)
        ? []
        : (this.#logs.get(reviewId) ?? []);
    log.push(sequenced);
    if (log.length > MAX_EVENTS_PER_REVIEW) log.splice(0, log.length - MAX_EVENTS_PER_REVIEW);
    this.#logs.set(reviewId, log);
    this.#broadcast?.(reviewId, sequenced);
  }

  /** The review's round events so far, oldest→newest. Empty when no round has dispatched
   *  — the honest absence the run machine starts from. */
  read(reviewId: string): readonly RoundEvent[] {
    return this.#logs.get(reviewId) ?? [];
  }

  /** A sink bound to one review — what a round's `onProgress` is handed. */
  sinkFor(reviewId: string): (event: RoundEvent) => void {
    return (event) => this.emit(reviewId, event);
  }
}
