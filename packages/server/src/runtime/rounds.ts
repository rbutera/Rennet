// ─────────────────────────────────────────────────────────────────────────────
// The rounds loop state machine + the consuming turn (#486 R34/R57–R58, #457,
// B09 cluster 6). The `server/runtime/` home B06 established, sibling to
// `lens-pipeline.ts` and `project-scout.ts`.
//
// A ROUND takes the reviewer's dispatched asks, runs the worked change WATCHED
// LIVE, and — on return — regenerates the boards over the moved code and pins a
// `RoundRecord` accounting for what the round did. This is the composition root
// B08 deliberately left unbuilt (B08 ledger A1): `runLensPipeline` gets its
// first non-test caller here, its open seams supplied from `createRoundsRuntime`
// following the `createProjectScoutRuntime`
// precedent (reconciliation 3).
//
// What is Rennet's, not the pipeline's:
//   1. SERIALIZE dispatches per session — one round in flight per session (a
//      second `runRound` for the same session queues behind the first). Fresh
//      code minted under two racing rounds would fork the generation ledger.
//   2. GENERATION lifecycle (#457, append-then-freeze) — when the code moves the
//      prior generation FREEZES and a successor is MINTED; when nothing landed
//      the existing generation remains current and the round records no report.
//   3. IDEMPOTENT drafting per (session, generation visit) — the pipeline start routes
//      through cluster 5's `PipelineStartGuard`, keyed on the boardGeneration id
//      (derived from the landed patchset plus durable dispatch identity).
//      The guard is the same-PROCESS fast path; across a restart it is empty, so
//      durable completion is the generation's five lens slots, each backed by its
//      BoardMeta or an honest absence. Partial evidence retries; complete evidence
//      reconstructs without re-drafting (B09 F1).
//   4. RECORD the round — a `RoundRecord` pinning asks, worker commit range,
//      minted generation, board generation, and the round-report board; the
//      rounds ledger is `RoundRecord[]` data (no UI — C9 out of scope).
//
// B09 does NOT edit the pipeline's pure logic: the round-report drafts FIRST and
// gates the regeneration, all five lens lanes then start together, per-board arrival
// powers the reveal, and durable `persistBoardMeta` writes are all the pipeline's own
// behavior. This runtime only wires the seams.
// ─────────────────────────────────────────────────────────────────────────────

import {
  createMetricsCollector,
  type DesignArtifactSet,
  mergeGenerationUsage,
  summarizeUsage,
  type T3SeatSeam,
  WhiteboardClient,
} from "@rennet/adapters";
import type {
  CodexExecutor,
  DeltaPacket,
  HarnessPort,
  LintContext,
  LintHunk,
  LintTarget,
  RegisterLintContext,
} from "@rennet/core";
import type { GenerationUsage } from "@rennet/protocol";
import {
  type AskOccurrence,
  type BenchmarkRun,
  type ComposedHandoffBundle,
  type DraftBoard,
  DraftBoardSchema,
  GENERATION_TIMINGS_VERSION,
  type Generation,
  type GenerationCoverage,
  type GenerationPhaseTiming,
  generationIdForDispatch,
  generationIdForPatchset,
  type LaneLatest,
  type LaneSeat,
  type LaneThreadRef,
  LENS_KINDS,
  type LensAbsenceReason,
  type LensFailureAccount,
  type LensKind,
  type LensLane,
  lensAdmitsAbsence,
  ROUND_NO_REGEN,
  type RoundEvent,
  type RoundRecord,
  type RoundRunReceipt,
  type SessionModel,
} from "@rennet/protocol";
import { generationBenchmarkRun } from "../benchmark-recorder";
import type { BoardsRuntime } from "../boards/boards-runtime";
import { PipelineStartGuard } from "../session/pipeline-guard";
import {
  type BoardArrivalEvent,
  type BoardMeta,
  createDesignCoverageMapper,
  deleteBoardElements,
  draftsRoundReport,
  type LensBoardOutcome,
  type LensPipelineDeps,
  type LensPipelineResult,
  type PromptReader,
  type RoundDraftContext,
  runLensPipeline,
} from "./lens-pipeline";

/** The boards one round drafts: the five lenses plus the round-report seat. */
const LINT_TARGETS: readonly LintTarget[] = [...LENS_KINDS, "report"];

/** The regeneration block's lane label per lens — the reviewer's name for the drafter. */
const LENS_LANE_LABEL: Record<LensKind, string> = {
  design: "Design",
  sequence: "Sequence",
  decisions: "Decisions",
  flagged: "Flagged",
  noise: "Noise",
};

/** One lens lane's STATE — every arm of {@link LensLane} minus the identity the lane keeps
 *  across transitions. Distributive on purpose, so each arm keeps its own fields. */
type LaneState = LensLane extends infer Arm
  ? Arm extends LensLane
    ? Omit<Arm, "id" | "label">
    : never
  : never;

/**
 * The per-lens regeneration lanes (C15 3.1/3.3) — the live block the round greeting
 * renders beneath the report. Lanes are held as a SNAPSHOT and re-emitted whole on every
 * change, matching the `lens` event's snapshot contract (a duplicate or re-ordered frame
 * just re-states rows the client already folded).
 *
 * Once the required report is verified and durably handed off, all five independent lens
 * turns run concurrently. Each lane starts together and settles only from its own
 * persistence/arrival event.
 */
const sameThreadRef = (a: LaneThreadRef | undefined, b: LaneThreadRef): boolean =>
  a !== undefined && a.environmentId === b.environmentId && a.threadId === b.threadId;

export function createRegenerationLanes(emit: (lanes: readonly LensLane[]) => void) {
  const lanes = new Map<LensKind, LensLane>(
    LENS_KINDS.map((lens) => [lens, { id: lens, label: LENS_LANE_LABEL[lens], status: "queued" }]),
  );
  const snapshot = (): readonly LensLane[] => [...lanes.values()];
  /** Replace a lane WHOLE — the state is a union, so a lane moves from one legal shape to
   *  another rather than being patched into an in-between that carries the wrong fields. */
  const set = (lens: LensKind, next: LaneState): void => {
    const current = lanes.get(lens);
    if (!current) return;
    // The thread ref and the seats are lane IDENTITY, not lane state: they survive every
    // transition so a settled or failed reader still opens its transcripts. A seat's
    // `latest` is state, though — only a running lane has something in flight — so it is
    // dropped on every transition out of `running`, exactly as the lane's own is.
    const seats =
      current.seats === undefined
        ? undefined
        : next.status === "running"
          ? current.seats
          : current.seats.map(({ latest: _latest, ...seat }) => seat);
    lanes.set(lens, {
      id: lens,
      label: LENS_LANE_LABEL[lens],
      ...(current.thread === undefined ? {} : { thread: current.thread }),
      ...(seats === undefined ? {} : { seats }),
      ...next,
    });
  };
  /** The lane a seat belongs to, or nothing for a seat with no lane (the report seat). */
  const laneOf = (seat: string): { lens: LensKind; lane: LensLane } | undefined => {
    const lens = laneForSeat(seat);
    const lane = lens === undefined ? undefined : lanes.get(lens);
    return lens === undefined || lane === undefined ? undefined : { lens, lane };
  };
  return {
    /** Re-emit the current lane snapshot unchanged. The coverage state rides the same
     *  frame as the lanes (#725 D4), so a coverage transition republishes the rows rather
     *  than opening a second channel that could disagree with them. */
    refresh(): void {
      emit(snapshot());
    },
    /** The lens drafters are under way. Called when the round report lands (it gated the
     *  regeneration) AND at the pipeline's own lens kickoff, which fires on every run —
     *  including the one where a report was expected and failed, the case an arrival-only
     *  trigger left reading `queued` for the whole run. Idempotent by construction: only
     *  queued lanes are promoted, so the second caller is a no-op rather than a reset. */
    start(): void {
      const queued = LENS_KINDS.filter((lens) => lanes.get(lens)?.status === "queued");
      if (queued.length === 0) return;
      for (const lens of queued) set(lens, { status: "running" });
      emit(snapshot());
    },
    /**
     * The seat's thread exists (t3-lens-threads 2.3). Recorded from the moment it does
     * and kept on EVERY later state, so a settled lane still opens its transcript.
     * Silent on the wire: it re-emits the snapshot, nothing else moves.
     */
    thread(seat: string, provider: LaneSeat["provider"], thread: LaneThreadRef): void {
      const found = laneOf(seat);
      if (!found) return;
      const { lens, lane: current } = found;
      // Addressed by SEAT, not by lane: Flagged runs a Claude seat and a Codex seat on
      // the same lane, and the second to arrive must join the first, never replace it.
      // Seats are held in arrival order; `seats[0]` is the primary the lane's own
      // `thread`/`latest` mirror.
      const seats = [...(current.seats ?? [])];
      const index = seats.findIndex((entry) => entry.seat === seat);
      const known = index >= 0 ? seats[index] : undefined;
      if (known !== undefined && sameThreadRef(known.thread, thread)) return;
      const entry: LaneSeat = { ...(known ?? { seat, provider }), thread };
      if (known === undefined) seats.push(entry);
      else seats[index] = entry;
      const primary = seats[0];
      lanes.set(lens, {
        ...current,
        seats,
        ...(primary?.thread === undefined ? {} : { thread: primary.thread }),
      });
      emit(snapshot());
    },
    /**
     * The newest thing this seat is doing, from its thread subscription. Only a RUNNING
     * lane has something in flight, so a publication for any other state is dropped —
     * which is also how a settled lane stops showing a line it can no longer refresh.
     * The lane's own `latest` follows the PRIMARY seat only, so a two-seat lane's line
     * never flips between speakers; the other seat's line lives on its seat entry.
     */
    progress(seat: string, latest: LaneLatest): void {
      const found = laneOf(seat);
      if (found?.lane.status !== "running") return;
      const { lens, lane: current } = found;
      const seats = (current.seats ?? []).map((entry) =>
        entry.seat === seat ? { ...entry, latest } : entry,
      );
      const primary = seats.length === 0 || seats[0]?.seat === seat;
      lanes.set(lens, {
        ...current,
        ...(seats.length === 0 ? {} : { seats }),
        ...(primary ? { latest } : {}),
      });
      emit(snapshot());
    },
    /** A lens board's draft landed. The lane reads `drafted`, NOT `done`: cross-lens
     *  coverage has not run and the delta
     *  verdict is not known yet, and a settled lane without its verdict is exactly the
     *  in-between state the union refuses to represent. */
    drafted(lens: LensKind): void {
      set(lens, { status: "drafted" });
      emit(snapshot());
    },
    /**
     * A lens board ARRIVED, carrying its delta verdict. **C15 3.3 (hard constraint):**
     * `carried` is the pipeline's `isCarriedForward` read of the stamps `stampDeltas`
     * wrote — the SAME signal the board's own section markers render, and it now accounts
     * for REMOVED sections too. A lens whose sections changed or went away therefore
     * CANNOT read "carrying forward"; it reads "reworked".
     */
    arrived(lens: LensKind, carried: boolean): void {
      set(lens, { status: "done", verdict: carried ? "carrying-forward" : "reworked" });
      emit(snapshot());
    },
    /**
     * A drafter produced no board. Its lane SETTLES as failed carrying the real reason —
     * a lane left `queued` or `running` after the round is over reads as "still working",
     * which is a lie the reviewer would wait on.
     */
    failed(lens: LensKind, reason: string): void {
      set(lens, { status: "failed", reason });
      emit(snapshot());
    },
    /** Discovery completed successfully and found no material for this lens. */
    absent(lens: LensKind, reason: string): void {
      set(lens, { status: "absent", reason });
      emit(snapshot());
    },
  };
}

/** B08's `BoardMeta` tagged with the durable idempotency linkage (B09 F1): the
 *  (session, patchset generation) that drafted the board. The composition root
 *  persists this so a fresh runtime after a restart can recognize an already-
 *  drafted generation from durable evidence. */
export interface PersistedBoardMeta extends BoardMeta {
  readonly session: string;
  readonly generation: string;
}

// ── Generation lifecycle (#457 append-then-freeze) — pure state machine ──

/** Mint a fresh LIVE generation for a patchset (append-only boards until frozen). */
export function mintGeneration(
  id: string,
  patchsetId: string,
  projectContextRevision?: string,
): Generation {
  return {
    id,
    patchsetId,
    ...(projectContextRevision === undefined ? {} : { projectContextRevision }),
    lensBoards: {},
    status: "live",
  };
}

/** Freeze a generation immutable — called on the prior generation when code moves. */
export function freezeGeneration(gen: Generation): Generation {
  return gen.status === "frozen" ? gen : { ...gen, status: "frozen" };
}

/**
 * The defect message for a lens settling an absence its row does not admit (#549), or
 * `undefined` when the pairing is admissible. `LENS_ADMISSIBLE_ABSENCES` is the protocol's
 * table; this is the write-path enforcement of it. The DURABLE `GenerationSchema` stays
 * append-only permissive on purpose: sessions persisted before this check must keep
 * parsing, so the boundary that refuses a wrong pairing is the write, never the read.
 */
function inadmissibleAbsenceFailure(lens: LensKind, reason: LensAbsenceReason): string | undefined {
  return lensAdmitsAbsence(lens, reason)
    ? undefined
    : `${lens} lens settled the absence \`${reason}\`, which ${lens} does not admit — recorded as a failure, never persisted as a clean result.`;
}

function lensAbsenceMessage(reason: LensAbsenceReason): string {
  switch (reason) {
    case "no-material":
      return "No Design specification applies to this change.";
    case "no-decisions":
      return "No material engineering decisions were found.";
    case "no-findings":
      return "No review findings were found.";
    case "no-noise":
      return "No safely skippable noise was found.";
  }
}

/**
 * Do two records describe the SAME drafting attempt (#725 7.2)? The attempt's identity is
 * its pre-minted board slots: a later attempt mints new ones, and a generation that has
 * settled drops `draftingBoardIds` entirely. So a durable record that no longer matches
 * this attempt's slots means this attempt has been SUPERSEDED, and its late writes must be
 * dropped rather than folded into whatever holds the generation now.
 */
export function sameDraftingAttempt(a: Generation, b: Generation): boolean {
  if (a.draftingReportBoardId !== b.draftingReportBoardId) return false;
  return LENS_KINDS.every((lens) => a.draftingBoardIds?.[lens] === b.draftingBoardIds?.[lens]);
}

/**
 * Rebuild the reveal a reader should see for a generation from DURABLE state alone
 * (#725 7.2) — which lanes settled with what, and where coverage stands. This is what a
 * reconnect or a daemon restart shows instead of a reset or an invented completion.
 *
 * Two honesty rules it enforces, and both matter:
 *
 *  • A settled board reconstructs as `drafted`, not `done`. `done` REQUIRES the
 *    carried/reworked verdict, and that verdict lives in the board's own delta stamps —
 *    not in the durable generation. `drafted` is the representable "its board landed, the
 *    verdict is not known here", so nothing is invented to fill the field.
 *  • A RETRYABLE failure reconstructs as `queued`, not `failed`. Wave 3's restart recovery
 *    re-drafts exactly those lanes, so a lane about to be re-drafted is pending again —
 *    reporting it settled-failed would be a lie the redraft is already contradicting.
 */
export function revealFromGeneration(gen: Generation): {
  readonly lanes: readonly LensLane[];
  readonly coverage?: GenerationCoverage;
} {
  const lanes = LENS_KINDS.map((lens): LensLane => {
    const base = { id: lens, label: LENS_LANE_LABEL[lens] } as const;
    if (gen.lensBoards[lens] !== undefined) return { ...base, status: "drafted" };
    const absence = gen.absentLenses?.[lens];
    if (absence !== undefined) {
      return { ...base, status: "absent", reason: lensAbsenceMessage(absence) };
    }
    const failure = gen.failedLenses?.[lens];
    if (failure !== undefined && gen.failedLensAccounts?.[lens]?.classification !== "retryable") {
      return { ...base, status: "failed", reason: failure };
    }
    return { ...base, status: "queued" };
  });
  return { lanes, ...(gen.coverage === undefined ? {} : { coverage: gen.coverage }) };
}

/**
 * Record the lens board ids a drafting run produced onto a generation. The
 * round-report is not a lens (excluded); composition emits no sixth board (C3),
 * so `compositionBoardId` stays absent.
 */
export function withLensBoards(
  gen: Generation,
  result: Pick<LensPipelineResult, "boards">,
): Generation {
  const lensBoards: Partial<Record<LensKind, string>> = {};
  const absentLenses: Partial<Record<LensKind, LensAbsenceReason>> = {};
  const failedLenses: Partial<Record<LensKind, string>> = {};
  const failedLensAccounts: Partial<Record<LensKind, LensFailureAccount>> = {};
  const fail = (lens: LensKind, message: string, account?: LensFailureAccount): void => {
    failedLenses[lens] = message;
    if (account !== undefined) failedLensAccounts[lens] = account;
  };
  for (const o of result.boards) {
    if (o.lens === "report") continue;
    if (o.boardId !== undefined) {
      lensBoards[o.lens] = o.boardId;
      delete absentLenses[o.lens];
    } else if (o.absence !== undefined) {
      // #549 — admissibility is ENFORCED where an outcome becomes durable, not merely
      // advised. A lens settling an absence its own row does not admit is a producer
      // defect; persisting it would make a wrong pairing indistinguishable from a real
      // clean result forever after. It settles as a typed failure instead.
      const inadmissible = inadmissibleAbsenceFailure(o.lens, o.absence);
      if (inadmissible === undefined) {
        absentLenses[o.lens] = o.absence;
        delete lensBoards[o.lens];
      } else {
        // RETRYABLE, and the attempt count says why: no retry has been spent on this lens,
        // and `terminal` in this model means the retries ARE spent. A seat that settled an
        // absence its row does not admit is exactly what another drafting attempt answers.
        fail(o.lens, inadmissible, { attempt: 0, classification: "retryable" });
      }
    } else {
      fail(o.lens, o.failure ?? "The drafter produced no board.", o.failureAccount);
    }
  }
  const generationWithoutAttempt = { ...gen };
  delete generationWithoutAttempt.draftingBoardIds;
  delete generationWithoutAttempt.absentLenses;
  delete generationWithoutAttempt.failedLenses;
  delete generationWithoutAttempt.failedLensAccounts;
  return {
    ...generationWithoutAttempt,
    lensBoards,
    ...(Object.keys(absentLenses).length === 0 ? {} : { absentLenses }),
    ...(Object.keys(failedLenses).length === 0 ? {} : { failedLenses }),
    ...(Object.keys(failedLensAccounts).length === 0 ? {} : { failedLensAccounts }),
  };
}

/**
 * How many reworks the round actually PRODUCED, counted off the report the round-report
 * seat wrote: its `round_outcome` items that are not `untouched`. The report verifies each
 * ask against the round's own diff rather than taking the worker's word, so this is the
 * round's verified account of the work — never `asksDispatched.length`, which counts how
 * many asks went OUT and would read "5 reworks" for a round that changed nothing.
 *
 * `beyond` COUNTS. The agent changed code in response to the round — work nobody asked
 * for is still work the round produced, and it is the opposite of `untouched`. (Settled,
 * so it does not get re-litigated: only `untouched` means "this round did nothing here".)
 *
 * `undefined` when the round drafted no report (or its board never came back): the count
 * is then honestly UNKNOWN, and the ledger renders no number rather than a zero it
 * cannot stand behind.
 */
function reportedReworkCount(report: LensBoardOutcome | undefined): number | undefined {
  const board = report?.board;
  if (board === undefined) return undefined;
  return board.elements.filter(
    (el) => el.kind === "round_outcome" && el.data.status !== "untouched",
  ).length;
}

/** A no-code turn has no successor to report. Strip a stale account before drafting so
 *  the report seat cannot describe an earlier round as if it belonged to this one. */
function withoutSuccessorAccount(packet: DeltaPacket): DeltaPacket {
  const { successorAccount, ...withoutAccount } = packet;
  return successorAccount === undefined ? packet : withoutAccount;
}

/** BoardMeta is generation-scoped, while reports account for one specific round. Reusing
 *  an existing generation may restore its lens boards, but never its prior report. */
function withoutRoundReport(result: LensPipelineResult): LensPipelineResult {
  const { report, ...withoutReport } = result;
  return report === undefined ? result : withoutReport;
}

/** The drafters' own failure reasons, for the terminal event a board-less round emits. */
function failureReasons(pipeline: LensPipelineResult): string {
  const reasons = [pipeline.report, ...pipeline.boards].flatMap((outcome) =>
    outcome === undefined || outcome.boardId !== undefined || outcome.absence !== undefined
      ? []
      : [`${outcome.lens}: ${outcome.failure ?? "no board"}`],
  );
  return reasons.length > 0 ? reasons.join("; ") : "no drafter reported a reason";
}

const REQUIRED_CORE_LENSES = ["sequence", "decisions", "flagged"] as const;

/** The review cannot advance without its three load-bearing reading surfaces. Sequence
 * must always contain a real board; Decisions and Flagged may instead settle with their
 * explicit typed clean result. A drafter failure is never equivalent to either clean
 * result, even when Design or Noise happened to produce useful boards beside it. */
function missingRequiredCoreLens(
  outcomes: readonly LensBoardOutcome[],
): (typeof REQUIRED_CORE_LENSES)[number] | undefined {
  for (const lens of REQUIRED_CORE_LENSES) {
    const outcome = outcomes.find((candidate) => candidate.lens === lens);
    if (outcome?.boardId !== undefined) continue;
    // Admissibility is the protocol's to declare, not this function's to restate:
    // Sequence admits no absence, so it is missing whenever it has no board.
    if (outcome?.absence !== undefined && lensAdmitsAbsence(lens, outcome.absence)) continue;
    return lens;
  }
  return undefined;
}

// ── The round call ──

/** The regeneration handoff: the worker's observed commit range plus the recaptured
 *  patchset when checkpoint diff/path evidence proved the tree changed. */
export interface WorkerReturn {
  readonly commitRange: { readonly from: string; readonly to: string };
  /** The activated post-worker patchset; absent when the checkpoint was empty. */
  readonly patchsetId?: string;
}

/** One round's inputs — the per-round pipeline universe plus the worked change. */
export interface RoundInput {
  readonly session: SessionModel;
  /** The review's durable identity root: boards, meta, ports, and transitions key on it. */
  readonly repoRoot: string;
  /**
   * The EVIDENCE checkout the drafter seats run in (a detached worktree pinned
   * at the reviewed head). Seat cwd ONLY — board storage and every persisted
   * key stay on {@link repoRoot}, or a restart could not find its own boards.
   * Absent ⇒ seats run at {@link repoRoot}.
   */
  readonly draftingRoot?: string;
  /** Durable ids reserved before drafting starts. A restarted report attempt reuses
   * these boards and generation instead of minting a second set after a crash. */
  readonly draftPlan?: RoundDraftPlan;
  /**
   * The REAL prior generation this round succeeds — the one whose boards were actually
   * drafted and persisted (frozen if the code moves). **Absent means absent:** a session
   * that has never regenerated has no predecessor, so the round is a first generation —
   * nothing freezes and the record carries no `frozenPredecessor`. Never synthesize one:
   * a fabricated predecessor makes the ledger's drill-down point at a generation that
   * never existed, and it makes carry-forward structurally impossible (every section
   * stamps `new` against boards that were never drafted).
   */
  readonly previousGeneration?: Generation;
  /** Exact structural-map + knowledge revision the drafters consume. A different revision
   * invalidates durable evidence for the same patchset and starts a replacement attempt. */
  readonly projectContextRevision?: string;
  /** Thread ids of the asks this round dispatched (pinned into the `RoundRecord`). */
  readonly asksDispatched: readonly string[];
  /** Stable identity of the exact staged-ask occurrence this regeneration completes. */
  readonly dispatchId?: string;
  /** Patchset the dispatched work order was built from. */
  readonly sourcePatchsetId?: string;
  /** The exact staged occurrences eligible for successful cleanup. */
  readonly askOccurrences?: readonly AskOccurrence[];
  /** Exact durable asks and finding overlays for a real reviewer-dispatched round. */
  readonly round?: RoundDraftContext;
  /** Re-read the reviewer overlay at the exact Flagged composition boundary. */
  readonly readFindingDispositions?: LensPipelineDeps["readFindingDispositions"];
  /** Persist reviewer-owned finding reattachments before Flagged is written. */
  readonly persistFindingResolutions?: LensPipelineDeps["persistFindingResolutions"];
  /** Validate the exact drafted report before any successor generation, quote migration,
   * or real-generation ledger row becomes authoritative. A throw leaves the durable
   * completed placeholder retryable and preserves the dispatched asks. */
  readonly verifyDraftedReport?: (report: {
    readonly reportBoardId: string;
    readonly generation: string;
    readonly patchsetId: string;
  }) => void | Promise<void>;
  /** Run the dispatched work WATCHED LIVE — the injected worker turn (a coding-agent
   *  loop upstream); this runtime owns serialization + recording, not the exec. */
  readonly runWorkers: () => Promise<WorkerReturn>;
  /** The pinned packet over the current patchset. A landed round carries the new
   *  `successorAccount`; the no-code boundary removes any stale prior account. */
  readonly deltaPacket: DeltaPacket;
  readonly hunks: readonly LintHunk[];
  readonly lintContextFor: (lens: LintTarget) => LintContext;
  /** Deterministically discovered Design artifacts; null means discovery succeeded with no spec. */
  readonly designArtifacts?: DesignArtifactSet | null;
  /** Pinned Design discovery failed; Design settles failed while sibling lenses continue. */
  readonly designArtifactFailure?: string;
  /** The prior generation's boards, for the pipeline's R58 delta stamps (optional). */
  readonly previous?: ReadonlyMap<LintTarget, DraftBoard>;
  /**
   * The live round-progress sink (C15 3.1) — where this round's REAL regeneration
   * progress goes: the round-report's arrival, each lens drafter starting and finishing,
   * the carried/reworked verdict per lens, the minted generation, and a terminal failure.
   * The caller (the composition root) owns the transport; this runtime owns only the
   * mapping from pipeline callbacks to events. Absent ⇒ no live channel, same round.
   */
  readonly onProgress?: (event: RoundEvent) => void;
  /** Load-bearing report handoff. The runtime awaits it before observers or lens seats start. */
  readonly onReportProgress?: (
    event: Extract<RoundEvent, { readonly type: "report" }>,
  ) => void | Promise<void>;
  /**
   * The composed review draft's citation grounding. REQUIRED (W5): an absent one
   * grounds the composition lint on an empty inventory, so every real `path:line`
   * the draft cites reports "does not resolve" on the surface the reviewer reads.
   * `assembleRoundCollation` builds it from the same head inventory as the boards,
   * so a caller that spreads a `RoundCollation` already carries it.
   */
  readonly reviewDraftLintCtx: RegisterLintContext;
  readonly curationFeedback?: string;
  /**
   * When the reviewer's wait for a board actually STARTED (#725 D4), as a wall-clock
   * epoch. This is the origin `first-core-board` measures from, and only the caller knows
   * it: on an initial generation it is the moment the captured input was ready to draft
   * over; on a returned round it is the moment the round's code landed and its report was
   * verified. Measuring from this runtime's own entry instead would silently exclude board
   * minting, partial-state cleanup, attempt persistence and provider resolution — real
   * seconds the reviewer spends staring at a spinner.
   *
   * Absent ⇒ the runtime falls back to its own start, which is honest about being a lower
   * bound rather than inventing an earlier origin.
   */
  readonly firstBoardWaitOriginMs?: number;
  readonly signal?: AbortSignal;
}

export interface RoundDraftPlan {
  readonly generation: string;
  readonly boardIds: Readonly<Record<LintTarget, string>>;
}

export interface RoundOutcome {
  readonly record: RoundRecord;
  /** The generation the boards were drafted against — LIVE, lens board ids recorded. */
  readonly boardGeneration: Generation;
  /** The prior generation, frozen because the code moved (present iff a patchset landed). */
  readonly frozenPrevious?: Generation;
  readonly pipeline: LensPipelineResult;
}

/** A dispatched coding turn whose durable checkpoint proved the tree did not change. */
export interface UnchangedRoundInput {
  readonly session: SessionModel;
  readonly asksDispatched: readonly string[];
  readonly dispatchId?: string;
  readonly sourcePatchsetId?: string;
  readonly askOccurrences?: readonly AskOccurrence[];
  readonly workerCommitRange: WorkerReturn["commitRange"];
  readonly onProgress?: (event: RoundEvent) => void;
}

/** What the composition root hands a generation so its seats can run as T3 threads. */
export interface T3SeatRuntime {
  readonly seam: T3SeatSeam;
  /** The sidecar environment a lane's `thread` ref is addressed in. */
  readonly environmentId: string;
  /** Hold the seat thread's subscription and publish its latest event, throttled. */
  readonly watch: (
    threadId: string,
    publish: (latest: LaneLatest) => void,
  ) => { readonly stop: () => void };
}

/** Which lane a seat's thread belongs to. The report seat has no lens lane. */
export function laneForSeat(seat: string): LensKind | undefined {
  if (seat === "flagged-claude" || seat === "flagged-codex") return "flagged";
  return (LENS_KINDS as readonly string[]).includes(seat) ? (seat as LensKind) : undefined;
}

// ── The composition-root factory (the swarm/scout precedent) ──

export interface RoundsRuntimeDeps {
  /** The locus-aware Claude port probe (null when no `claude` resolves). */
  readonly resolveClaudePort: (repoRoot: string) => Promise<HarnessPort | null>;
  /** The locus-aware codex utility executor probe (null when no `codex` resolves). */
  readonly resolveCodexExecutor: (repoRoot: string) => Promise<CodexExecutor | null>;
  /**
   * The T3 sidecar's seat runtime for one generation (t3-lens-threads). `null` ⇒ this
   * daemon has no sidecar, and the board seats fall back to the ephemeral legs.
   */
  readonly resolveT3Seats?: (input: {
    readonly repoRoot: string;
    readonly generationId: string;
    readonly branch: string;
    /** The session that owns the generation, so archiving it can delete these threads. */
    readonly sessionId: string;
  }) => Promise<T3SeatRuntime | null>;
  /** B04's boards runtime for a repo — the sole board-op writer (`WhiteboardClient`
   *  over its `service`) and the board minter (`createRennetBoard`). */
  readonly boardsRuntimeFor: (
    repoRoot: string,
  ) => Pick<BoardsRuntime, "service" | "createRennetBoard">;
  /** Read a prompt file's text (`createNodePromptReader` in production; hermetic in tests). */
  readonly readPrompt: PromptReader;
  /** The durable board-meta store's write (B08 finding 3); absent ⇒ metadata is
   *  result-only. Carries the (session, generation) linkage so the durable
   *  idempotency read below can find it (B09 F1). */
  readonly persistBoardMeta?: (repoRoot: string, meta: PersistedBoardMeta) => void | Promise<void>;
  /** The durable idempotency read (B09 F1): the board-meta already on disk for a
   *  (session, generation). Together with the persisted generation's lens-board ids and
   *  honest absences, this distinguishes a complete draft from a partial crash. Absent ⇒
   *  only the in-memory guard dedups (same-process re-entry, no restart proof). */
  readonly loadDraftedBoards?: (
    repoRoot: string,
    sessionId: string,
    generation: string,
  ) => readonly BoardMeta[];
  /** Remove one board's durable metadata before retry cleanup mutates its board state. */
  readonly removeBoardMeta?: (repoRoot: string, boardId: string) => void | Promise<void>;
  /** The per-board arrival broadcast that powers the progressive reveal (R58). */
  readonly onBoardArrival?: (event: BoardArrivalEvent) => void | Promise<void>;
  /** The orchestrator's heavy authoring turn for the composition write-through (C2),
   *  resolved per repo. Absent ⇒ composition is skipped (the lens boards are the surface). */
  readonly composeTurn?: (
    repoRoot: string,
  ) => ((prompt: string) => Promise<string> | string) | undefined;
  /** The initial generation id minter. Returned rounds add durable dispatch identity. */
  readonly newGenerationId?: (patchsetId: string) => string;
  /** Persist a minted generation durably (C15 2.1) — called for the live successor (with
   *  its lens board ids recorded) and, when the code moved, the frozen prior. Absent ⇒
   *  generations are process-lived only; present ⇒ the frozen prior survives a restart as
   *  a drill-down the ledger's switcher can open by id ({@link RoundsRuntime.generation}). */
  readonly persistGeneration?: (gen: Generation) => void | Promise<void>;
  /** Persist a round record to the durable ledger (C15 2.2), reconciling to ONE record per
   *  round — the real-generation record supersedes the dispatch placeholder for the same
   *  round. Called by BOTH the dispatch and the regeneration paths; absent ⇒ in-memory only. */
  readonly recordRound?: (sessionId: string, record: RoundRecord) => void;
  /** Read the durable rounds ledger for a session (C15 2.2). Present ⇒ `ledger()` returns the
   *  reconciled durable records; absent ⇒ `ledger()` falls back to the in-memory ledger. */
  readonly readRounds?: (sessionId: string) => readonly RoundRecord[];
  /** Read a persisted generation by id (C15 2.3) — the switcher-facing drill-down read the
   *  ledger uses to open the frozen predecessor. Absent/never-persisted ⇒ `undefined`
   *  (honest); the store throws on a corrupt file. */
  readonly loadGeneration?: (id: string) => Generation | undefined;
  /** Reconcile durable quote threads after both ends of a real generation transition have
   *  landed. The callback is retry-safe: a crash before the round record causes the same
   *  transition to run again, and its event planner emits only missing overwrites. */
  readonly onGenerationTransition?: (transition: {
    readonly repoRoot: string;
    readonly reviewId: string;
    readonly sessionId: string;
    readonly sourceGeneration: string;
    readonly successorGeneration: string;
  }) => void | Promise<void>;
  /** The wall clock, injectable so a test can script the phase timings this runtime
   *  records. Shared with the pipeline, so one run measures on ONE clock. */
  readonly now?: () => number;
  /**
   * Archive one generation's benchmark record (#731 D8). Handed the phases this runtime
   * ALREADY wrote durably — nothing is re-measured for it — so a disabled recorder is
   * simply an absent dep and the drafting path is byte-for-byte the same either way.
   * Absent ⇒ no archive; the durable `Generation.timings` are untouched regardless.
   */
  readonly recordBenchmark?: (run: BenchmarkRun) => void;
}

/** One round DISPATCH — the reviewer's dispatched asks folded into ONE work-order and
 *  handed to the workers, serialized per session (B11 cluster 4). Lighter than a full
 *  `RoundInput`: this step runs and durably checkpoints the coding turn; the composition
 *  root then supplies the recaptured collation to `runRound` for regeneration. */
/** What a dispatched round produced — the checkpoint-measured change and the honest
 *  outcome classification, the substance the runtime pins into a `RoundRecord`. The
 *  diff + changed paths come from `GitCheckpointStore` (via the injected worker turn),
 *  not the worker's account of itself; a failed turn still carries the partial diff. */
export interface DispatchRoundResult {
  readonly outcome: "completed" | "failed";
  readonly diff: string;
  readonly changedPaths: readonly string[];
  /** HEAD before → after the turn. Equal when the worker committed nothing (honest:
   *  the checkpoint diff carries the change, no commit landed). */
  readonly workerCommitRange: { readonly from: string; readonly to: string };
}

export interface RoundDispatchInput {
  readonly session: SessionModel;
  /** The composed work-order the dispatched asks folded into — the workers' input. */
  readonly workOrder: ComposedHandoffBundle;
  /** Stable identity of this exact set of staged-ask occurrences. */
  readonly dispatchId: string;
  /** Patchset the work order was built from. */
  readonly sourcePatchsetId: string;
  /** Exact staged occurrences this dispatch may consume after successful regeneration. */
  readonly askOccurrences: readonly AskOccurrence[];
  /** Immutable host facts for the durable ledger row created by this dispatch. */
  readonly run: RoundRunReceipt;
  /** Run the composed work-order WATCHED LIVE (the injected coding-agent turn upstream);
   *  the runtime owns the per-session serialization + recording, never the exec. Returns
   *  the round's result so `dispatchRound` records a `RoundRecord`; a `void` return records
   *  nothing (the serializer-only path used where no round result exists). */
  // accepts a worker callback that legitimately returns nothing (the record-nothing path);
  // `undefined` would reject a `Promise<void>`-returning callback.
  // biome-ignore lint/suspicious/noConfusingVoidType: `void` is deliberate here — the union
  readonly runWorkers: (workOrder: ComposedHandoffBundle) => Promise<DispatchRoundResult | void>;
  /** The live round-progress sink — the SAME channel `runRound` reports on. Present ⇒ a
   *  dispatch that dies emits a terminal `failed`; absent ⇒ no live channel, same round. */
  readonly onProgress?: (event: RoundEvent) => void;
}

export interface RoundsRuntime {
  /** Run one round for a session, serialized behind any round already in flight for it. */
  runRound(input: RoundInput): Promise<RoundOutcome>;
  /** Dispatch a round's composed work-order, serialized per session behind any round already
   *  in flight for it — one round per session, the SAME serializer `runRound` uses (no second
   *  lock). The handler coalesces same-process repeats before they reach this method; the
   *  completed placeholder is the later cross-restart commit point. */
  dispatchRound(input: RoundDispatchInput): Promise<void>;
  /** Settle an empty-checkpoint dispatch without loading any board-drafting context. */
  finalizeUnchanged(input: UnchangedRoundInput): Promise<RoundRecord>;
  /** The session's rounds ledger — every `RoundRecord` this runtime recorded, in order. */
  ledger(sessionId: string): readonly RoundRecord[];
  /** Read a minted generation by id (C15 2.3) — the ledger's `GenerationSwitcher` drills back
   *  to a round's frozen predecessor (`RoundRecord.frozenPredecessor`) through this. Absent
   *  generation (or no durable store) ⇒ `undefined`; the store throws on a corrupt file. */
  generation(id: string): Generation | undefined;
}

export function createRoundsRuntime(deps: RoundsRuntimeDeps): RoundsRuntime {
  // Initial drafting has no round row. Returned rounds use the dispatch-derived visit id;
  // the durable ledger then tells clients which generation is current after restart.
  const newGenerationId = deps.newGenerationId ?? generationIdForPatchset;
  const clock = deps.now ?? Date.now;
  const guard = new PipelineStartGuard();
  const ledger = new Map<string, RoundRecord[]>();
  // Per-session promise tails — one round in flight per session (the SessionTurnLoop
  // pattern). The stored tail swallows rejection so a failed round never wedges the
  // queue; the returned promise carries the real outcome.
  const tails = new Map<string, Promise<unknown>>();

  /** Run `task` serialized behind the session's current round — the ONE per-session lock
   *  both `runRound` and `dispatchRound` share (no second lock, B11 cluster 4). */
  function enqueue<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const prior = tails.get(sessionId) ?? Promise.resolve();
    const run = prior.then(task);
    tails.set(
      sessionId,
      run.catch(() => undefined),
    );
    return run;
  }

  function finalizeUnchanged(input: UnchangedRoundInput): RoundRecord {
    const completedPlaceholder = deps
      .readRounds?.(input.session.id)
      .findLast(
        (record) =>
          record.boardGeneration === ROUND_NO_REGEN &&
          record.outcome === "completed" &&
          record.regeneration === "pending" &&
          (input.dispatchId === undefined
            ? record.dispatchId === undefined &&
              record.workerCommitRange.from === input.workerCommitRange.from &&
              record.workerCommitRange.to === input.workerCommitRange.to
            : record.dispatchId === input.dispatchId),
      );
    const record: RoundRecord = {
      ...(completedPlaceholder ?? {
        asksDispatched: [...input.asksDispatched],
        ...(input.dispatchId === undefined ? {} : { dispatchId: input.dispatchId }),
        ...(input.sourcePatchsetId === undefined
          ? {}
          : { sourcePatchsetId: input.sourcePatchsetId }),
        ...(input.askOccurrences === undefined
          ? {}
          : { askOccurrences: [...input.askOccurrences] }),
        workerCommitRange: { ...input.workerCommitRange },
        boardGeneration: ROUND_NO_REGEN,
        reportBoard: ROUND_NO_REGEN,
        outcome: "completed",
      }),
      regeneration: "not-needed",
    };
    const records = ledger.get(input.session.id) ?? [];
    const pendingIndex = records.findLastIndex(
      (candidate) =>
        candidate.boardGeneration === ROUND_NO_REGEN &&
        candidate.outcome === "completed" &&
        candidate.dispatchId !== undefined &&
        candidate.dispatchId === record.dispatchId,
    );
    if (pendingIndex >= 0) records[pendingIndex] = record;
    else records.push(record);
    ledger.set(input.session.id, records);
    deps.recordRound?.(input.session.id, record);
    input.onProgress?.({ type: "unchanged" });
    return record;
  }

  /** Does the Generation's state have enough exact durable evidence to reconstruct?
   * Every lens must own exactly one terminal board, absence, or failure. A named board is
   * terminal only when its exact durable metadata exists. Sequence must be a board, while
   * Decisions and Flagged may be boards or their typed clean absences; failures in those
   * three core lanes remain partial. A report-required run additionally owns one exact
   * reserved report record; five settled lenses cannot substitute for it.
   *
   * A RETRYABLE failure is not terminal evidence (#549). Its own durable account says the
   * lens still has attempts left, so counting it as settled wedged the lens: a fresh
   * runtime reconstructed the same retryable failure from disk forever and never re-drafted
   * it. Treating it as an unsettled slot sends the generation down the partial-evidence
   * path, which redrafts. This is the RESTART path only — an in-flight retryable settle is
   * the drafting ladder's to answer inside its own lane, and re-entering the whole
   * generation for one would spend a full regeneration on it. */
  function hasCompleteLensEvidence(
    generation: Generation,
    records: readonly BoardMeta[],
    reportRequired: boolean,
  ): boolean {
    const terminalKinds = LENS_KINDS.map((lens) => {
      const boardId = generation.draftingBoardIds?.[lens] ?? generation.lensBoards[lens];
      const hasBoard =
        boardId !== undefined &&
        records.some((record) => record.lens === lens && record.boardId === boardId);
      const hasAbsence = generation.absentLenses?.[lens] !== undefined;
      // An older generation carries no account; its silence stays silence, not a
      // classification this reconstruction would be inventing.
      const hasFailure =
        generation.failedLenses?.[lens] !== undefined &&
        generation.failedLensAccounts?.[lens]?.classification !== "retryable";
      if (Number(hasBoard) + Number(hasAbsence) + Number(hasFailure) !== 1) return undefined;
      if (hasBoard) return "board";
      return hasAbsence ? "absence" : "failure";
    });
    const lensesComplete =
      terminalKinds.every((kind) => kind !== undefined) &&
      terminalKinds.includes("board") &&
      missingRequiredCoreLens(reconstructFromMeta(records, generation).boards) === undefined;
    if (!lensesComplete || !reportRequired) return lensesComplete;
    const reportBoardId = generation.draftingReportBoardId;
    return (
      reportBoardId !== undefined &&
      records.some((record) => record.lens === "report" && record.boardId === reportBoardId)
    );
  }

  /** Reconstruct the drafting result from complete durable BoardMeta (B09 F1): a fresh
   *  runtime after a restart rebuilds the board ids + per-board blemish metadata from the
   *  exact records its Generation names. A recovery redraft can leave metadata from its
   *  partial predecessor on disk; those unreferenced records are deliberately ignored.
   *
   *  COVERAGE IS OMITTED, not emptied. Cross-lens coverage is computed from the drafted
   *  boards (which hunks each one teaches) and the boards are not in the durable meta —
   *  so a restored round CANNOT know its coverage picture. Reporting `[]` here said "this
   *  round covered every hunk", which is a claim the reconstruction never verified; the
   *  honest answer is that it cannot say. */
  function reconstructFromMeta(
    records: readonly BoardMeta[],
    generation: Generation,
  ): LensPipelineResult {
    const byBoardId = new Map(records.map((record) => [record.boardId, record]));
    const outcomes: LensBoardOutcome[] = [];
    for (const lens of LENS_KINDS) {
      const absence = generation.absentLenses?.[lens];
      if (absence !== undefined) {
        outcomes.push({ lens, omissions: [], blemishes: [], immutability: [], absence });
        continue;
      }
      const failure = generation.failedLenses?.[lens];
      if (failure !== undefined) {
        // The durable account rides back with the message (#549): a restart that restored
        // only the words had to treat every failure as terminal, which is a claim the
        // reconstruction never verified. An older generation carries no account, and that
        // absence stays absent rather than being defaulted to a classification.
        const failureAccount = generation.failedLensAccounts?.[lens];
        outcomes.push({
          lens,
          omissions: [],
          blemishes: [],
          immutability: [],
          failure,
          ...(failureAccount === undefined ? {} : { failureAccount }),
        });
        continue;
      }
      const boardId = generation.lensBoards[lens] ?? generation.draftingBoardIds?.[lens];
      const record = boardId === undefined ? undefined : byBoardId.get(boardId);
      if (record?.lens === lens) {
        outcomes.push({
          lens,
          boardId: record.boardId,
          omissions: record.omissions,
          blemishes: record.blemishes,
          immutability: record.immutability,
        });
      }
    }
    const reports = records.filter((record) => record.lens === "report");
    const ownedReportMeta =
      generation.draftingReportBoardId === undefined
        ? reports.length === 1
          ? reports[0]
          : undefined
        : byBoardId.get(generation.draftingReportBoardId);
    const reportMeta = ownedReportMeta?.lens === "report" ? ownedReportMeta : undefined;
    const report: LensBoardOutcome | undefined =
      reportMeta === undefined
        ? undefined
        : {
            lens: "report",
            boardId: reportMeta.boardId,
            omissions: reportMeta.omissions,
            blemishes: reportMeta.blemishes,
            immutability: reportMeta.immutability,
          };
    return {
      boards: outcomes,
      ...(report === undefined ? {} : { report }),
    };
  }

  /** Pre-mint the round's boards, resolve ports, and run the pipeline once. New generations
   *  enter through the start guard; partial durable generations call this directly because
   *  the guard may already hold their settled incomplete result. */
  async function draft(
    input: RoundInput,
    boardGeneration: Generation,
    start: "fresh" | "partial",
  ): Promise<{
    readonly generation: Generation;
    readonly pipeline: LensPipelineResult;
    /** Take the benchmark archive for this attempt. Called by `runOnce` at the attempt's
     *  TERMINAL boundary — after the last check that can reclassify the outcome — and a
     *  no-op once the attempt has already been archived or found superseded. */
    readonly archiveBenchmark: (
      outcome: "complete" | "failed" | "aborted",
      failure?: string,
    ) => void;
  }> {
    const boards = deps.boardsRuntimeFor(input.repoRoot);
    const whiteboard = new WhiteboardClient(boards.service);
    const boardIds = new Map<LintTarget, string>();
    for (const target of LINT_TARGETS) {
      boardIds.set(target, await boards.createRennetBoard(input.draftPlan?.boardIds[target]));
    }
    const boardIdFor = (lens: LintTarget): string => {
      const id = boardIds.get(lens);
      if (id === undefined) throw new Error(`rounds: no board minted for ${lens}`);
      return id;
    };
    const draftingBoardIds = Object.fromEntries(
      LENS_KINDS.map((lens) => [lens, boardIdFor(lens)]),
    ) as Partial<Record<LensKind, string>>;
    const generationWithoutAbsences = { ...boardGeneration };
    delete generationWithoutAbsences.absentLenses;
    delete generationWithoutAbsences.failedLenses;
    // The account goes with the sentence it accounts for. Leaving it behind survived a
    // crash between this attempt's persistence and its settle, and the next reader found
    // an account whose failure had already been cleared — a classification about nothing.
    delete generationWithoutAbsences.failedLensAccounts;
    // Coverage is ATTEMPT-scoped, and leaving it behind was the same defect one level up:
    // this attempt is about to clear five boards and re-draft them, so a `complete` state
    // from the attempt being replaced would sit beside queued lanes on the reconnecting
    // surface, saying every hunk is covered by boards that no longer exist.
    delete generationWithoutAbsences.coverage;
    const attemptGeneration: Generation = {
      ...generationWithoutAbsences,
      lensBoards: {},
      draftingBoardIds,
      draftingReportBoardId: boardIdFor("report"),
      // A repeat attempt is stamped PENDING at mint. It becomes durable with the
      // attempt write below, which lands AFTER the cleanup loop (see the
      // attempt-identity note before that write) — so a crash inside cleanup leaves
      // the replaced attempt's record, not a half-pending one.
      ...(start === "partial" ? { coverage: { state: "pending" as const } } : {}),
      ...(input.designArtifacts === null
        ? { absentLenses: { design: "no-material" as const } }
        : {}),
    };
    const durableRecords =
      start === "partial"
        ? (deps.loadDraftedBoards?.(input.repoRoot, input.session.id, attemptGeneration.id) ?? [])
        : [];
    const reusableReportMeta =
      start !== "partial" || input.round?.worker === undefined
        ? undefined
        : durableRecords.find(
            (record) =>
              record.lens === "report" &&
              record.boardId === attemptGeneration.draftingReportBoardId,
          );
    let reusableRoundReport: LensPipelineDeps["reusableRoundReport"];
    if (reusableReportMeta !== undefined) {
      const state = [...(await boards.service.getState(reusableReportMeta.boardId)).values()];
      const recovered = DraftBoardSchema.safeParse({
        ...(reusableReportMeta.document === undefined
          ? {}
          : { document: reusableReportMeta.document }),
        elements: state,
        skippedHunks: reusableReportMeta.skippedHunks,
      });
      if (recovered.success) {
        reusableRoundReport = {
          boardId: reusableReportMeta.boardId,
          board: recovered.data,
          omissions: reusableReportMeta.omissions,
          blemishes: reusableReportMeta.blemishes,
          immutability: reusableReportMeta.immutability,
        };
      }
    }

    if (start === "partial") {
      // #725 7.2 — the reconnecting surface sees what durably settled and where coverage
      // stands BEFORE this attempt clears and redrafts, so a restart mid-generation reads
      // as "here is what we have, still working" instead of a reset to nothing. The
      // redraft's own snapshot moves those lanes back to running immediately after.
      const resumed = revealFromGeneration(boardGeneration);
      input.onProgress?.({
        type: "lens",
        lanes: [...resumed.lanes],
        // NOT `resumed.coverage`. What durably settled about coverage described the boards
        // this attempt is about to delete; re-publishing it would show "every hunk covered"
        // beside lanes that are queued for a redraft. The honest state is pending, and it
        // rides the FIRST frame — the client's fold keeps the last known coverage when a
        // frame carries none, so an omission here would leave the stale one standing.
        coverage: { state: "pending" },
      });
      for (const target of LINT_TARGETS) {
        const boardId = boardIdFor(target);
        if (target === "report" && reusableRoundReport?.boardId === boardId) continue;
        // Metadata must disappear first. A crash before the state clear then retries this
        // same reconciliation; it can never reconstruct from metadata for a board whose
        // old elements are about to be replaced.
        await deps.removeBoardMeta?.(input.repoRoot, boardId);
        const state = [...(await boards.service.getState(boardId)).values()];
        if (state.length === 0) continue;
        const cleared = await deleteBoardElements(
          whiteboard,
          boardId,
          state.reverse().map((element) => element.id),
          "host:round-retry-recovery",
        );
        if (!cleared.ok) {
          throw new Error(
            `rounds: could not clear partial ${target} board ${boardId} (${cleared.code})`,
          );
        }
      }
    }

    // Attempt identity lands after cleanup and before any new BoardMeta. A crash at any
    // cleanup point leaves the prior partial identity retryable; a crash after this write
    // leaves the replacement attempt identifiable by these exact reserved ids.
    await deps.persistGeneration?.(attemptGeneration);

    const [claudePort, codexExecutor] = await Promise.all([
      deps.resolveClaudePort(input.repoRoot),
      deps.resolveCodexExecutor(input.repoRoot),
    ]);
    // t3-lens-threads — the sidecar's seat runtime for THIS generation. Absent (no
    // vendored bundle, or a direct-call test) leaves the ephemeral legs in place.
    const t3Runtime = await deps
      .resolveT3Seats?.({
        repoRoot: input.draftingRoot ?? input.repoRoot,
        generationId: attemptGeneration.id,
        branch: input.deltaPacket.patchset.repository.baseRef,
        sessionId: input.session.id,
      })
      .catch(() => null);
    const seatWatches: { readonly stop: () => void }[] = [];
    const watchedThreads = new Set<string>();
    const composeTurn = deps.composeTurn?.(input.repoRoot);
    const persistBoardMeta = deps.persistBoardMeta;

    // ── The live progress mapping (C15 3.1) ──
    // Two pipeline callbacks carry the real regeneration timeline: `persistBoardMeta`
    // fires as each board's draft lands (per-lens progress, in completion order), and
    // `onBoardArrival` fires once the board is announced — the report inline and ahead
    // of the lenses, the lenses together after cross-lens coverage, each carrying its
    // delta verdict. Both are wrapped here so the round's own sink sees them without the
    // pipeline learning about the wire.
    const onProgress = input.onProgress;
    const onReportProgress = input.onReportProgress;
    // ── The generation's durable reveal state (#725 D4/7.2) ──
    // Per-lane settlements, the explicit coverage state and the per-phase timings, all
    // keyed to THIS drafting attempt's reserved board slots.
    // The generation's spend tap (#737): every seat turn the pipeline runs records here,
    // and the sum rides the lens frame while drafting and lands on the durable generation.
    const collector = createMetricsCollector();
    // A repeat attempt ADDS to what the generation already spent (its durable `usage`
    // from the prior attempt); it never replaces it with the new attempt alone.
    const usageSoFar = (): { usage?: GenerationUsage } => {
      const merged = mergeGenerationUsage(
        attemptGeneration.usage,
        collector.metrics.length === 0 ? undefined : summarizeUsage(collector.metrics),
      );
      return merged === undefined ? {} : { usage: merged };
    };
    const reveal = {
      lensBoards: {} as Partial<Record<LensKind, string>>,
      absentLenses: {
        ...attemptGeneration.absentLenses,
      } as Partial<Record<LensKind, LensAbsenceReason>>,
      failedLenses: {} as Partial<Record<LensKind, string>>,
      failedLensAccounts: {} as Partial<Record<LensKind, LensFailureAccount>>,
      // Pending from the first frame on a repeat attempt, matching what was just persisted.
      coverage: attemptGeneration.coverage,
      timings: [] as GenerationPhaseTiming[],
    };
    /**
     * Write the reveal state durably, unless a LATER attempt (or the settle that dropped
     * this attempt's slots) already owns the generation. Rejecting here rather than at the
     * store means one check covers every reveal write — settlements, coverage and timings
     * all route through it, so none of them can be the one that folds a superseded
     * attempt's result into the current generation.
     *
     * Returns whether the write was ACCEPTED, and every caller gates its broadcast on it.
     * A rejection that returned nothing still let the arrival sink and the lane snapshot
     * run, so a superseded attempt was refused the disk and granted the screen — connected
     * clients saw a dead attempt's boards announced over the live generation's, which is
     * the same wrong-content publish the durable check exists to prevent.
     */
    const persistReveal = async (): Promise<boolean> => {
      const persist = deps.persistGeneration;
      if (persist === undefined) return true;
      const durable = deps.loadGeneration?.(attemptGeneration.id);
      if (durable !== undefined && !sameDraftingAttempt(durable, attemptGeneration)) return false;
      await persist({
        ...attemptGeneration,
        lensBoards: { ...reveal.lensBoards },
        ...(Object.keys(reveal.absentLenses).length === 0
          ? {}
          : { absentLenses: { ...reveal.absentLenses } }),
        ...(Object.keys(reveal.failedLenses).length === 0
          ? {}
          : {
              failedLenses: { ...reveal.failedLenses },
              failedLensAccounts: { ...reveal.failedLensAccounts },
            }),
        ...(reveal.coverage === undefined ? {} : { coverage: reveal.coverage }),
        ...(reveal.timings.length === 0
          ? {}
          : {
              timings: { version: GENERATION_TIMINGS_VERSION, phases: [...reveal.timings] },
            }),
        ...usageSoFar(),
      });
      return true;
    };
    const lanes =
      onProgress === undefined
        ? undefined
        : createRegenerationLanes((rows) => {
            void onProgress({
              type: "lens",
              lanes: [...rows],
              // Coverage rides the SAME frame as the lanes, so the surface can never show
              // settled boards from one moment and a coverage state from another.
              ...(reveal.coverage === undefined ? {} : { coverage: reveal.coverage }),
              // Spend rides the same frame for the same reason (#737).
              ...usageSoFar(),
            });
          });
    // Time-to-first-core-board is measured from the moment the REVIEWER's wait began, which
    // the caller holds and this runtime does not: the captured input becoming ready on an
    // initial generation, the round landing and its report verifying on a returned one.
    // Measuring from here would start the clock after board minting, partial-state cleanup,
    // attempt persistence and provider resolution — all of it wait the reviewer sits
    // through, all of it excluded from the number that claims to be the wait.
    const generationStartedAt = input.firstBoardWaitOriginMs ?? clock();
    const runtimeArrival = deps.onBoardArrival;
    const onBoardArrival = async (event: BoardArrivalEvent): Promise<void> => {
      if (event.lens === "report") {
        // The load-bearing progress sink verifies and records the report handoff.
        // Only then may an observer announce it or a lens seat start.
        const reportEvent = { type: "report" as const, reportBoardId: event.boardId };
        if (onReportProgress === undefined) onProgress?.(reportEvent);
        else await onReportProgress(reportEvent);
        await runtimeArrival?.(event);
        lanes?.start();
        return;
      }
      // The lane SETTLED. Its board id becomes durable here — before the observer runs —
      // so a reader reconstructing after a crash finds the settlement that was announced.
      const firstCore =
        reveal.timings.every((timing) => timing.phase !== "first-core-board") &&
        (REQUIRED_CORE_LENSES as readonly LensKind[]).includes(event.lens);
      if (firstCore) {
        reveal.timings.push({
          phase: "first-core-board",
          lens: event.lens,
          startedAtMs: generationStartedAt,
          durationMs: Math.max(0, clock() - generationStartedAt),
        });
      }
      reveal.lensBoards[event.lens] = event.boardId;
      // A rejected write means a LATER attempt owns this generation. Announcing anyway put
      // this dead attempt's board on every connected client's screen under the live
      // generation's label; the durable refusal and the broadcast are one decision.
      if (!(await persistReveal())) return;
      await runtimeArrival?.(event);
      lanes?.arrived(event.lens, event.carried);
    };
    const onCoverageState = async (coverage: GenerationCoverage): Promise<void> => {
      reveal.coverage = coverage;
      if (await persistReveal()) lanes?.refresh();
    };
    const onPhaseTiming = (timing: GenerationPhaseTiming): void => {
      reveal.timings.push(timing);
    };
    const onReportDiagnostic =
      onProgress === undefined
        ? undefined
        : (milestone: Extract<RoundEvent, { type: "report-diagnostic" }>["milestone"]): void => {
            void onProgress({ type: "report-diagnostic", milestone });
          };
    const onLensAbsence = async (lens: LensKind, reason: LensAbsenceReason): Promise<void> => {
      // The SAME admissibility enforcement `withLensBoards` applies at the final
      // settle — this is the other path by which an absence becomes durable, and a
      // check on only one of them would let a wrong pairing through the early write.
      const inadmissible = inadmissibleAbsenceFailure(lens, reason);
      if (inadmissible !== undefined) {
        reveal.failedLenses[lens] = inadmissible;
        // Retryable for the same reason the settle path stamps it: nothing has been
        // retried yet, so this lens has every attempt still in front of it.
        reveal.failedLensAccounts[lens] = { attempt: 0, classification: "retryable" };
      } else {
        reveal.absentLenses[lens] = reason;
      }
      // Same gate as the arrival: a superseded attempt is refused the screen as well as
      // the disk, so the lane snapshot only moves for the attempt that still owns this
      // generation.
      if (!(await persistReveal())) return;
      if (inadmissible !== undefined) lanes?.failed(lens, inadmissible);
      else lanes?.absent(lens, lensAbsenceMessage(reason));
    };

    // The seam the pipeline sees: the sidecar's own `client`/`threadFor`, plus the lane
    // wiring. A seat's thread reference reaches its lane the moment the thread exists,
    // and the subscription that feeds the lane's live line starts with it.
    const t3Seam: T3SeatSeam | undefined =
      t3Runtime === null || t3Runtime === undefined
        ? undefined
        : {
            client: t3Runtime.seam.client,
            threadFor: t3Runtime.seam.threadFor,
            onThread: (seat, thread, provider) => {
              if (laneForSeat(seat) === undefined || lanes === undefined) return;
              // By SEAT: the two Flagged seats share a lane and must not overwrite each
              // other's thread or line.
              lanes.thread(seat, provider, {
                environmentId: t3Runtime.environmentId,
                threadId: thread.threadId,
              });
              if (watchedThreads.has(thread.threadId)) return;
              watchedThreads.add(thread.threadId);
              seatWatches.push(
                t3Runtime.watch(thread.threadId, (latest) => lanes.progress(seat, latest)),
              );
            },
          };

    const pipelineInput = {
      claudePort,
      codexExecutor,
      ...(t3Seam === undefined ? {} : { t3: t3Seam }),
      repoRoot: input.draftingRoot ?? input.repoRoot,
      deltaPacket: input.deltaPacket,
      currentGeneration: attemptGeneration.id,
      ...(input.round === undefined
        ? {}
        : {
            round: {
              ...input.round,
              previousFlaggedBoardId: input.previousGeneration?.lensBoards.flagged,
            },
          }),
      ...(input.readFindingDispositions === undefined
        ? {}
        : { readFindingDispositions: input.readFindingDispositions }),
      ...(input.persistFindingResolutions === undefined
        ? {}
        : { persistFindingResolutions: input.persistFindingResolutions }),
      hunks: input.hunks,
      lintContextFor: input.lintContextFor,
      ...(input.designArtifacts === undefined
        ? {}
        : {
            designArtifacts: input.designArtifacts,
            ...(claudePort === null
              ? {}
              : {
                  mapDesignCoverage: createDesignCoverageMapper(
                    claudePort,
                    input.draftingRoot ?? input.repoRoot,
                    collector,
                  ),
                }),
          }),
      ...(input.designArtifactFailure === undefined
        ? {}
        : { designArtifactFailure: input.designArtifactFailure }),
      readPrompt: deps.readPrompt,
      collector,
      whiteboard,
      boardIdFor,
      ...(reusableRoundReport === undefined ? {} : { reusableRoundReport }),
      ...(deps.removeBoardMeta === undefined
        ? {}
        : {
            removeBoardMeta: (boardId: string) => deps.removeBoardMeta?.(input.repoRoot, boardId),
          }),
      onBoardArrival,
      onCoverageState,
      onPhaseTiming,
      // A `"partial"` start is a REPEATED whole-board attempt over this generation — the
      // redraft wave 3's restart recovery runs. It draws the reduced per-lane ladder
      // (#725 7.5), which is what bounds the cost of one restart to less than a full
      // fresh generation rather than the same again.
      boardAttempt: start === "partial" ? 1 : 0,
      ...(onReportDiagnostic === undefined ? {} : { onReportDiagnostic }),
      onLensAbsence,
      ...(lanes === undefined ? {} : { onLensDraftingStart: () => lanes.start() }),
      ...(persistBoardMeta === undefined && lanes === undefined
        ? {}
        : {
            // Tag each board's meta with the (session, generation) that drafted it,
            // so the durable idempotency read can recognize this generation after a
            // restart (B09 F1). The pipeline's pure logic is untouched — this
            // composition wrapper adds the linkage, and (C15 3.1) marks the lens's
            // lane done: a board's meta persists the moment its draft lands, which is
            // the real per-lens progress the reveal block streams.
            persistBoardMeta: (meta: BoardMeta) => {
              if (meta.lens !== "report") lanes?.drafted(meta.lens);
              return persistBoardMeta?.(input.repoRoot, {
                ...meta,
                session: input.session.id,
                generation: attemptGeneration.id,
              });
            },
          }),
      ...(input.previous === undefined ? {} : { previous: input.previous }),
      ...(composeTurn === undefined ? {} : { composeTurn }),
      reviewDraftLintCtx: input.reviewDraftLintCtx,
      ...(input.curationFeedback === undefined ? {} : { curationFeedback: input.curationFeedback }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      // One clock for the round: the pipeline's phase spans and this runtime's
      // first-core-board origin have to be comparable, and two clocks are not.
      ...(deps.now === undefined ? {} : { now: deps.now }),
    } satisfies Parameters<typeof runLensPipeline>[0];

    // Lens progress used to be promoted only by the round report's ARRIVAL. The initial
    // path has no report, so it could read "queued" while lens work was live.
    // `onLensDraftingStart` promotes all five lanes only when the no-report path is valid or
    // the required report has been verified and persisted; a failed report exits earlier.

    // The benchmark archive's producer (#731 D8). It rides the SAME records the reveal
    // block already wrote, so nothing here measures anything twice, and the `catch` below
    // means a generation that threw is archived as `failed` rather than vanishing — a
    // pipeline that only archived its successes would report the fast half of its own
    // latency. `aborted` is the caller's cancellation, told apart from a real failure by
    // the signal, because a reviewer who walked away is not a defect.
    //
    // The archive is NOT taken here on the success path. This function returns before the
    // attempt is terminal: `runOnce` still has to find lens boards, verify the drafted
    // report and check the required core lenses, and each of those can throw — so an
    // archive taken at the end of the pipeline filed as `complete` a generation that was
    // about to be rejected. The closure returned below is called at that true boundary,
    // and it records at most once whoever calls it first.
    //
    // A SUPERSEDED attempt archives nothing at all. When `persistReveal` refuses the write
    // because a later attempt owns the generation, this attempt's numbers are not this
    // generation's, and filing them under its id would put a dead attempt's latency on the
    // live generation's row.
    const benchmarkFrom = Math.floor(clock());
    const benchmarkAttempt = start === "partial" ? 1 : 0;
    let benchmarkArchived = false;
    let benchmarkSuperseded = false;
    const archiveBenchmark = (
      outcome: "complete" | "failed" | "aborted",
      failure?: string,
    ): void => {
      const record = deps.recordBenchmark;
      if (record === undefined || benchmarkArchived || benchmarkSuperseded) return;
      benchmarkArchived = true;
      record(
        generationBenchmarkRun({
          subject: {
            label: input.session.id,
            sessionId: input.session.id,
            generationId: attemptGeneration.id,
            ...(input.dispatchId === undefined ? {} : { roundId: input.dispatchId }),
          },
          attempt: benchmarkAttempt,
          phases: reveal.timings,
          startedAtMs: benchmarkFrom,
          endedAtMs: Math.floor(clock()),
          outcome,
          ...(failure === undefined ? {} : { failure }),
        }),
      );
    };

    let pipeline: LensPipelineResult;
    try {
      pipeline = await runLensPipeline(pipelineInput);
    } catch (error) {
      archiveBenchmark(
        input.signal?.aborted === true ? "aborted" : "failed",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    } finally {
      // Every seat has settled: the live lines are over, so the sockets that fed them go
      // with them. Held open they would keep publishing into lanes nothing reads (2.3).
      for (const watch of seatWatches) watch.stop();
      seatWatches.length = 0;
    }
    // A drafter that produced no board settles its lane as failed. Without this the lane
    // sits at `queued`/`running` after the round is over — the surface reads "still
    // working" forever, which is the same stall a silent crash leaves behind.
    for (const outcome of pipeline.boards) {
      if (outcome.boardId !== undefined || outcome.lens === "report") continue;
      if (outcome.absence !== undefined) continue;
      lanes?.failed(outcome.lens, outcome.failure ?? "the drafter produced no board");
    }
    // One last write so the timings recorded after the final settlement (coverage, reveal,
    // the lens post-process tails) reach durable state too. A REFUSED write means a later
    // attempt owns this generation, and this attempt archives nothing.
    if (!(await persistReveal())) benchmarkSuperseded = true;
    // …and the generation handed back carries them, because that record is what the final
    // settle and BOTH failure paths persist. `withLensBoards` spreads the generation it is
    // given and deletes only the attempt-scoped drafting fields, so coverage and timings
    // ride through it — returning the bare `attemptGeneration` instead meant the last write
    // of every round erased every durable coverage state and every timing the run measured.
    return {
      generation: {
        ...attemptGeneration,
        ...(reveal.coverage === undefined ? {} : { coverage: reveal.coverage }),
        ...(reveal.timings.length === 0
          ? {}
          : { timings: { version: GENERATION_TIMINGS_VERSION, phases: [...reveal.timings] } }),
        // Usage rides the same record for the same reason (#741 review): the final settle
        // and both failure writes persist THIS object, and a write without it would erase
        // what persistReveal just landed.
        ...usageSoFar(),
      },
      pipeline,
      archiveBenchmark,
    };
  }

  async function runOnce(input: RoundInput): Promise<RoundOutcome> {
    // Run the dispatched work watched live, then regenerate over what it produced.
    const worked = await input.runWorkers();
    const landed = worked.patchsetId !== undefined;
    // A completed coding turn with no tree change has no new generation to reveal. The
    // dispatch path already fsynced its ROUND_NO_REGEN placeholder; retain that commit
    // point and terminate without reconstructing old boards or filing them as this round's
    // output. Askless first-generation drafting continues below unchanged.
    if (!landed && input.asksDispatched.length > 0) {
      const record = finalizeUnchanged({
        session: input.session,
        asksDispatched: input.asksDispatched,
        ...(input.dispatchId === undefined ? {} : { dispatchId: input.dispatchId }),
        ...(input.sourcePatchsetId === undefined
          ? {}
          : { sourcePatchsetId: input.sourcePatchsetId }),
        ...(input.askOccurrences === undefined ? {} : { askOccurrences: input.askOccurrences }),
        workerCommitRange: worked.commitRange,
        ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
      });
      return {
        record,
        boardGeneration:
          input.previousGeneration ??
          mintGeneration(
            newGenerationId(input.deltaPacket.patchset.id),
            input.deltaPacket.patchset.id,
          ),
        pipeline: { boards: [] },
      };
    }
    // Code moved ⇒ mint a successor generation; else retain the existing one. F8: two
    // rounds that land NOTHING share `previousGeneration.id`, so they share the
    // (session, generation) key — the second reuses the first's lens boards (the
    // in-memory guard, or the durable reconstruction below after a restart). Reports
    // are round-scoped, not generation-scoped, and are stripped below on this path.
    // Nothing landed and no prior generation ⇒ this is the session's FIRST generation over
    // the patchset the drafters are reading; mint it from that patchset rather than from a
    // predecessor that does not exist.
    const landedPatchsetId = worked.patchsetId;
    const landedGenerationId =
      landedPatchsetId === undefined
        ? undefined
        : (input.draftPlan?.generation ??
          (input.dispatchId === undefined
            ? newGenerationId(landedPatchsetId)
            : generationIdForDispatch(landedPatchsetId, input.dispatchId)));
    const selectedGeneration =
      landedPatchsetId !== undefined && landedGenerationId !== undefined
        ? (deps.loadGeneration?.(landedGenerationId) ??
          mintGeneration(landedGenerationId, landedPatchsetId, input.projectContextRevision))
        : (input.previousGeneration ??
          mintGeneration(
            newGenerationId(input.deltaPacket.patchset.id),
            input.deltaPacket.patchset.id,
            input.projectContextRevision,
          ));
    // Context is part of the durable generation identity even when the patchset is
    // unchanged. Keep the stable address clients already hold, but replace the attempt
    // and named boards so stale BoardMeta cannot satisfy the new revision.
    const boardGeneration =
      input.projectContextRevision !== undefined &&
      selectedGeneration.projectContextRevision !== input.projectContextRevision
        ? mintGeneration(
            selectedGeneration.id,
            selectedGeneration.patchsetId,
            input.projectContextRevision,
          )
        : selectedGeneration;

    // Durable idempotency across the crash boundary (F1): a fresh runtime after a
    // restart has an EMPTY in-memory guard. BoardMeta presence alone is insufficient —
    // a crash or one failed lens can leave a non-empty partial set. Reconstruct only when
    // all five generation slots are backed by their exact meta, an honest absence, or a
    // non-core failure, and the three core reading surfaces satisfy their stronger contract.
    // Partial durable state bypasses the guard (which may hold a settled incomplete run)
    // and redrafts; the new Generation ids become the authority over stale partial meta.
    const durableEvidence =
      deps.loadDraftedBoards?.(input.repoRoot, input.session.id, boardGeneration.id) ?? [];
    const draftingInput = landed
      ? input
      : { ...input, deltaPacket: withoutSuccessorAccount(input.deltaPacket) };
    const reportRequired = draftsRoundReport({
      currentGeneration: boardGeneration.id,
      deltaPacket: draftingInput.deltaPacket,
      ...(draftingInput.round === undefined ? {} : { round: draftingInput.round }),
    });
    let completeEvidence = hasCompleteLensEvidence(
      boardGeneration,
      durableEvidence,
      reportRequired,
    );
    if (completeEvidence && reportRequired && draftingInput.round?.worker !== undefined) {
      const reportBoardId = boardGeneration.draftingReportBoardId;
      if (reportBoardId === undefined || input.verifyDraftedReport === undefined) {
        completeEvidence = false;
      } else {
        try {
          await input.verifyDraftedReport({
            reportBoardId,
            generation: boardGeneration.id,
            patchsetId: boardGeneration.patchsetId,
          });
        } catch {
          // A semantically invalid stored report is partial evidence, not a terminal
          // generation. The retry path re-verifies the recovered board, removes its
          // metadata, clears it, and runs the one-shot classifier again.
          completeEvidence = false;
        }
      }
    }
    const hasPartialDurableState =
      durableEvidence.length > 0 ||
      Object.keys(boardGeneration.lensBoards).length > 0 ||
      Object.keys(boardGeneration.draftingBoardIds ?? {}).length > 0 ||
      Object.keys(boardGeneration.absentLenses ?? {}).length > 0 ||
      Object.keys(boardGeneration.failedLenses ?? {}).length > 0;
    const restoredOrDrafted = completeEvidence
      ? {
          generation: boardGeneration,
          pipeline: reconstructFromMeta(durableEvidence, boardGeneration),
          // Reconstructed from durable metadata: no pipeline ran, so there is nothing to
          // time. An archive here would file a cache hit as a very fast generation.
          archiveBenchmark: undefined,
        }
      : hasPartialDurableState
        ? await draft(draftingInput, boardGeneration, "partial")
        : await guard.start(
            input.session.id,
            `${boardGeneration.id}:${boardGeneration.projectContextRevision ?? "legacy"}`,
            () => draft(draftingInput, boardGeneration, "fresh"),
          );
    // Durable BoardMeta is keyed only by generation, so evidence for an existing
    // generation may contain the report from the round that minted it. A no-code round
    // can reuse those lens boards, but that old report is not evidence about this turn.
    const pipeline = landed
      ? restoredOrDrafted.pipeline
      : withoutRoundReport(restoredOrDrafted.pipeline);

    // The round-report seat's board, or the `ROUND_NO_REGEN` marker when the seat wrote
    // nothing. Every board id is PRE-MINTED before the drafters run, so recording the
    // pre-minted id here would file an empty board as the round's report — a ledger row
    // pointing at a document nobody wrote. Honest absence is the protocol's own contract
    // for this field ("`ROUND_NO_REGEN` when the round drafted no report board").
    const reportBoard = pipeline.report?.boardId ?? ROUND_NO_REGEN;
    // A report is an account of the round, not a regenerated review board. Filing a real
    // generation without its load-bearing core review evidence would turn a failed retry
    // into durable success and consume its asks. Persist the partial attempt but keep the
    // completed placeholder pending; the next regeneration call takes the cleanup path.
    // ── The attempt's TERMINAL boundary (#731 D8) ──
    // Everything that can still reclassify the outcome lives inside this block: a
    // generation with no lens boards, a round report that fails verification, a missing
    // required core lens. The archive used to be taken when the PIPELINE returned, which
    // is several throws too early — a generation rejected here was filed as `complete`,
    // and the export's failure rate was the rate at which the pipeline itself threw rather
    // than the rate at which a round failed. `archiveBenchmark` is absent when the
    // generation was reconstructed from durable metadata: nothing ran, so nothing is timed.
    const archiveBenchmark = restoredOrDrafted.archiveBenchmark;
    try {
      const draftedLensBoards = pipeline.boards.filter((outcome) => outcome.boardId !== undefined);
      if (draftedLensBoards.length === 0) {
        await deps.persistGeneration?.(withLensBoards(restoredOrDrafted.generation, pipeline));
        throw new Error(`The regeneration drafted no lens boards: ${failureReasons(pipeline)}`);
      }
      if (input.verifyDraftedReport !== undefined) {
        if (reportBoard === ROUND_NO_REGEN) {
          throw new Error("The regeneration drafted no round report to verify.");
        }
        await input.verifyDraftedReport({
          reportBoardId: reportBoard,
          generation: boardGeneration.id,
          patchsetId: boardGeneration.patchsetId,
        });
      }
      const missingCoreLens = missingRequiredCoreLens(pipeline.boards);
      if (missingCoreLens !== undefined) {
        await deps.persistGeneration?.(withLensBoards(restoredOrDrafted.generation, pipeline));
        throw new Error(
          `The required core lens ${missingCoreLens} did not produce review evidence: ${failureReasons(pipeline)}`,
        );
      }
    } catch (error) {
      archiveBenchmark?.(
        input.signal?.aborted === true ? "aborted" : "failed",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
    archiveBenchmark?.("complete");
    // The frozen predecessor (C15 2.2, un-parks C09 F3): when the code moved AND a real
    // prior generation exists, it freezes and its id is the earlier generation the ledger's
    // switcher drills back to. Absent on a no-move round and on a first generation —
    // honestly, there is no distinct predecessor to point at.
    const predecessor = landed ? input.previousGeneration : undefined;
    // The REPORT-DERIVED rework count (C15 finding 10): what the round's own report says
    // it did, persisted here so the ledger reads a number instead of inferring one from
    // how many asks went out.
    const reworkCount = reportedReworkCount(pipeline.report);
    const record: RoundRecord = {
      asksDispatched: [...input.asksDispatched],
      ...(input.dispatchId === undefined ? {} : { dispatchId: input.dispatchId }),
      ...(input.sourcePatchsetId === undefined ? {} : { sourcePatchsetId: input.sourcePatchsetId }),
      ...(input.askOccurrences === undefined ? {} : { askOccurrences: [...input.askOccurrences] }),
      workerCommitRange: { from: worked.commitRange.from, to: worked.commitRange.to },
      ...(landed ? { mintedPatchsetGeneration: boardGeneration.id } : {}),
      ...(landed ? { resultPatchsetId: boardGeneration.patchsetId } : {}),
      boardGeneration: boardGeneration.id,
      reportBoard,
      ...(reworkCount === undefined ? {} : { reworkCount }),
      ...(predecessor === undefined ? {} : { frozenPredecessor: predecessor.id }),
    };
    // WRITE ORDER, and it is load-bearing: the generations go down FIRST, the record that
    // points at them LAST. The record is the ledger row the switcher drills through, so a
    // crash between the two writes must leave a missing row (honest: the round is not in
    // the ledger yet) rather than a row whose generation was never written — a drill-down
    // into nothing. There is no transaction across two stores; ordering is the guarantee.
    const liveSuccessor = withLensBoards(restoredOrDrafted.generation, pipeline);
    await deps.persistGeneration?.(liveSuccessor);
    const frozenPrevious = predecessor === undefined ? undefined : freezeGeneration(predecessor);
    if (frozenPrevious !== undefined) await deps.persistGeneration?.(frozenPrevious);
    if (frozenPrevious !== undefined && input.session.reviewId !== undefined) {
      await deps.onGenerationTransition?.({
        repoRoot: input.repoRoot,
        reviewId: input.session.reviewId,
        sessionId: input.session.id,
        sourceGeneration: frozenPrevious.id,
        successorGeneration: liveSuccessor.id,
      });
    }

    // A drafting pass that dispatched NO asks and moved NO code is not a round — it is the
    // first read of a change, drafted when the review was opened. Recording it would put a
    // row in the reviewer's round history for work nobody ordered, light up the History pill
    // and open `?view=rounds` over a coding turn that never ran. Every real round has asks
    // (`round.dispatch` refuses an empty bundle before the runtime is ever reached), so this
    // excludes the capture draft and nothing else. The GENERATION is still persisted above:
    // the boards are real and have to be readable, it is the round row that would be a lie.
    const isRound = input.asksDispatched.length > 0 || landed;
    if (isRound) {
      const records = ledger.get(input.session.id) ?? [];
      records.push(record);
      ledger.set(input.session.id, records);
      // Reconcile to ONE durable record (C15 2.2): this real-generation record supersedes the
      // dispatch path's ROUND_NO_REGEN placeholder for the same round (same worker commit
      // range), keeping the placeholder's checkpoint diff/outcome. Absent store ⇒ in-memory only.
      deps.recordRound?.(input.session.id, record);
    }

    // The round composed (C15 3.1): the terminal event the run machine gates **View the
    // New Boards** on. Emitted with the generation the reveal lands on, so the control
    // appears at real composition — never as a disabled button waiting for a flag.
    //
    input.onProgress?.({ type: "composed", generation: liveSuccessor.id });

    return {
      record,
      boardGeneration: liveSuccessor,
      ...(frozenPrevious === undefined ? {} : { frozenPrevious }),
      pipeline,
    };
  }

  /**
   * Run a round's body with its live channel closed HONESTLY on a throw: a round that dies
   * — anywhere, on either entry point — emits a terminal `failed` rather than leaving the
   * run machine mid-phase forever, because a silent stall reads as "still working" and the
   * reviewer waits on it. ONE catch around the whole body, not a guard per failure site:
   * the throws that matter are the ones nobody predicted. The error still propagates — the
   * caller decides what a failed round means.
   */
  async function reported<T>(
    onProgress: ((event: RoundEvent) => void) | undefined,
    body: () => Promise<T>,
  ): Promise<T> {
    try {
      return await body();
    } catch (error) {
      onProgress?.({
        type: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  return {
    runRound(input: RoundInput): Promise<RoundOutcome> {
      return enqueue(input.session.id, () => reported(input.onProgress, () => runOnce(input)));
    },
    finalizeUnchanged(input: UnchangedRoundInput): Promise<RoundRecord> {
      return enqueue(input.session.id, () =>
        reported(input.onProgress, async () => finalizeUnchanged(input)),
      );
    },
    dispatchRound(input: RoundDispatchInput): Promise<void> {
      return enqueue(input.session.id, () =>
        reported(input.onProgress, async () => {
          const result = await input.runWorkers(input.workOrder);
          // A void return is the serializer-only path (no round result to pin) — the
          // per-session lock ran, nothing is recorded.
          if (!result) return;
          // Record the round. Part (a) is record-ONLY: no board is regenerated, so no
          // generation is minted and no report board drafted — both generation fields carry
          // the honest ROUND_NO_REGEN marker rather than a fabricated id (the mint is a
          // separate workstream). The asks are the work-order's own ask ids; the diff +
          // changed paths + commit range are the checkpoint-measured truth from the turn.
          const record: RoundRecord = {
            asksDispatched: input.askOccurrences.map((occurrence) => occurrence.id),
            dispatchId: input.dispatchId,
            sourcePatchsetId: input.sourcePatchsetId,
            askOccurrences: [...input.askOccurrences],
            workerCommitRange: {
              from: result.workerCommitRange.from,
              to: result.workerCommitRange.to,
            },
            boardGeneration: ROUND_NO_REGEN,
            reportBoard: ROUND_NO_REGEN,
            run: input.run,
            outcome: result.outcome,
            ...(result.outcome === "completed" ? { regeneration: "pending" as const } : {}),
            diff: result.diff,
            changedPaths: [...result.changedPaths],
          };
          const records = ledger.get(input.session.id) ?? [];
          records.push(record);
          ledger.set(input.session.id, records);
          // The durable placeholder (C15 2.2): a later `runRound` for the same round supersedes
          // this in the durable ledger with the real generation; a dispatch-only round keeps it.
          deps.recordRound?.(input.session.id, record);
          // A FAILED round is RECORDED (its partial diff is on disk) but still REJECTS, so
          // the dispatch command's per-key memo evicts and an identical re-dispatch retries
          // (B11 finding 4). The session tail swallows the rejection — the queue is not wedged.
          if (result.outcome === "failed") {
            throw new Error("The round's work order failed.");
          }
        }),
      );
    },
    ledger(sessionId: string): readonly RoundRecord[] {
      // The durable ledger (reconciled to one record per round) is the truth when a store is
      // wired; the in-memory map is the fallback for a runtime with no durability (tests).
      return deps.readRounds?.(sessionId) ?? ledger.get(sessionId) ?? [];
    },
    generation(id: string): Generation | undefined {
      return deps.loadGeneration?.(id);
    },
  };
}
