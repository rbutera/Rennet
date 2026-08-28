// ─────────────────────────────────────────────────────────────────────────────
// The rounds loop state machine + the consuming turn (#486 R34/R57–R58, #457,
// B09 cluster 6). The `server/runtime/` home B06 established, sibling to
// `knowledge-swarm.ts` and `lens-pipeline.ts`.
//
// A ROUND takes the reviewer's dispatched asks, runs the worked change WATCHED
// LIVE, and — on return — regenerates the boards over the moved code and pins a
// `RoundRecord` accounting for what the round did. This is the composition root
// B08 deliberately left unbuilt (B08 ledger A1): `runLensPipeline` gets its
// first non-test caller here, its open seams supplied from `createRoundsRuntime`
// following the `createKnowledgeSwarmRuntime`/`createProjectScoutRuntime`
// precedent (reconciliation 3).
//
// What is Rennet's, not the pipeline's:
//   1. SERIALIZE dispatches per session — one round in flight per session (a
//      second `runRound` for the same session queues behind the first). Fresh
//      code minted under two racing rounds would fork the generation ledger.
//   2. GENERATION lifecycle (#457, append-then-freeze) — when the code moves the
//      prior generation FREEZES and a successor is MINTED; when nothing landed
//      the round re-reports against the existing generation.
//   3. IDEMPOTENT drafting per (session, generation) — the pipeline start routes
//      through cluster 5's `PipelineStartGuard`, keyed on the boardGeneration id
//      (derived from the landed patchset so re-drafting the same patchset dedups).
//      The guard is the same-PROCESS fast path; across a restart it is empty, so
//      the durable truth is the BoardMeta on disk for the (session, generation)
//      (`loadDraftedBoards`): present ⇒ reconstruct, never re-draft (B09 F1).
//   4. RECORD the round — a `RoundRecord` pinning asks, worker commit range,
//      minted generation, board generation, and the round-report board; the
//      rounds ledger is `RoundRecord[]` data (no UI — C9 out of scope).
//
// B09 does NOT edit the pipeline's pure logic: the round-report drafts FIRST and
// gates the regeneration, per-board arrival powers the reveal, and the durable
// `persistBoardMeta` are all the pipeline's own behavior (`isRound` derived from
// `deltaPacket.successorAccount`) — this runtime only wires the seams.
// ─────────────────────────────────────────────────────────────────────────────

import { WhiteboardClient } from "@rennet/adapters";
import type {
  CodexExecutor,
  DeltaPacket,
  HarnessPort,
  LintContext,
  LintHunk,
  LintTarget,
  RegisterLintContext,
} from "@rennet/core";
import {
  type ComposedHandoffBundle,
  type DraftBoard,
  type Generation,
  type LaneRow,
  LENS_KINDS,
  type LensKind,
  ROUND_NO_REGEN,
  type RoundEvent,
  type RoundRecord,
  type SessionModel,
} from "@rennet/protocol";
import type { BoardsRuntime } from "../boards/boards-runtime";
import { PipelineStartGuard } from "../session/pipeline-guard";
import {
  type BoardArrivalEvent,
  type BoardMeta,
  type LensBoardOutcome,
  type LensPipelineResult,
  type PromptReader,
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

/**
 * The per-lens regeneration lanes (C15 3.1/3.3) — the live block the round greeting
 * renders beneath the report. Lanes are held as a SNAPSHOT and re-emitted whole on every
 * change, matching the `lens` event's snapshot contract (a duplicate or re-ordered frame
 * just re-states rows the client already folded).
 *
 * The pipeline drafts the lenses in `LENS_KINDS` order, one at a time, so "this lens
 * finished" (its board meta persists) is also "the next lens started" — the sequence is
 * read off the real run, never guessed from a clock.
 */
function createRegenerationLanes(emit: (lanes: readonly LaneRow[]) => void) {
  const lanes = new Map<LensKind, LaneRow>(
    LENS_KINDS.map((lens) => [lens, { id: lens, label: LENS_LANE_LABEL[lens], status: "queued" }]),
  );
  const snapshot = (): readonly LaneRow[] => [...lanes.values()];
  const set = (lens: LensKind, patch: Partial<LaneRow>): void => {
    const current = lanes.get(lens);
    if (current !== undefined) lanes.set(lens, { ...current, ...patch });
  };
  return {
    /** The first drafter is under way (the report gated the regeneration and landed). */
    start(): void {
      const first = LENS_KINDS[0];
      if (first !== undefined) set(first, { status: "running" });
      emit(snapshot());
    },
    /** A lens board's draft landed; the next lens in the pipeline's order is now running. */
    drafted(lens: LensKind): void {
      set(lens, { status: "done" });
      const next = LENS_KINDS[LENS_KINDS.indexOf(lens) + 1];
      if (next !== undefined && lanes.get(next)?.status === "queued")
        set(next, { status: "running" });
      emit(snapshot());
    },
    /**
     * A lens board ARRIVED, carrying its delta verdict. **C15 3.3 (hard constraint):**
     * `carried` is the pipeline's `isCarriedForward` read of the stamps `stampDeltas`
     * wrote — the SAME signal the board's own section markers render. A lens whose
     * sections changed therefore CANNOT read "carrying forward"; it reads "reworked".
     */
    arrived(lens: LensKind, carried: boolean): void {
      set(lens, { status: "done", detail: carried ? "carrying forward" : "reworked" });
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
export function mintGeneration(id: string, patchsetId: string): Generation {
  return { id, patchsetId, lensBoards: {}, status: "live" };
}

/** Freeze a generation immutable — called on the prior generation when code moves. */
export function freezeGeneration(gen: Generation): Generation {
  return gen.status === "frozen" ? gen : { ...gen, status: "frozen" };
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
  const lensBoards: Partial<Record<LensKind, string>> = { ...gen.lensBoards };
  for (const o of result.boards) {
    if (o.lens !== "report" && o.boardId !== undefined) lensBoards[o.lens] = o.boardId;
  }
  return { ...gen, lensBoards };
}

// ── The round call ──

/** The dispatched work's return: the commit range the workers produced, and the
 *  patchset it landed (absent if nothing landed — then the round re-reports). */
export interface WorkerReturn {
  readonly commitRange: { readonly from: string; readonly to: string };
  /** The patchset the worker commits produced; absent if the code did not move. */
  readonly patchsetId?: string;
}

/** One round's inputs — the per-round pipeline universe plus the worked change. */
export interface RoundInput {
  readonly session: SessionModel;
  /** The PR worktree the drafters are rooted at, and ports/boards resolve against. */
  readonly repoRoot: string;
  /** The live generation this round succeeds (frozen if the code moves). */
  readonly previousGeneration: Generation;
  /** Thread ids of the asks this round dispatched (pinned into the `RoundRecord`). */
  readonly asksDispatched: readonly string[];
  /** Run the dispatched work WATCHED LIVE — the injected worker turn (a coding-agent
   *  loop upstream); this runtime owns serialization + recording, not the exec. */
  readonly runWorkers: () => Promise<WorkerReturn>;
  /** The round delta packet (carries `successorAccount`, so the pipeline drafts as a round). */
  readonly deltaPacket: DeltaPacket;
  readonly hunks: readonly LintHunk[];
  readonly lintContextFor: (lens: LintTarget) => LintContext;
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
  readonly reviewDraftLintCtx?: RegisterLintContext;
  readonly curationFeedback?: string;
  readonly signal?: AbortSignal;
}

export interface RoundOutcome {
  readonly record: RoundRecord;
  /** The generation the boards were drafted against — LIVE, lens board ids recorded. */
  readonly boardGeneration: Generation;
  /** The prior generation, frozen because the code moved (present iff a patchset landed). */
  readonly frozenPrevious?: Generation;
  readonly pipeline: LensPipelineResult;
}

// ── The composition-root factory (the swarm/scout precedent) ──

export interface RoundsRuntimeDeps {
  /** The locus-aware Claude port probe (null when no `claude` resolves). */
  readonly resolveClaudePort: (repoRoot: string) => Promise<HarnessPort | null>;
  /** The locus-aware codex utility executor probe (null when no `codex` resolves). */
  readonly resolveCodexExecutor: (repoRoot: string) => Promise<CodexExecutor | null>;
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
   *  (session, generation). Non-empty ⇒ that generation already drafted its boards,
   *  so this runtime reconstructs from the evidence instead of re-minting/re-drafting
   *  — the crash-boundary truth the in-memory guard cannot survive a restart to carry.
   *  Absent ⇒ only the in-memory guard dedups (same-process re-entry, no restart proof). */
  readonly loadDraftedBoards?: (
    repoRoot: string,
    sessionId: string,
    generation: string,
  ) => readonly BoardMeta[];
  /** The per-board arrival broadcast that powers the progressive reveal (R58). */
  readonly onBoardArrival?: (event: BoardArrivalEvent) => void;
  /** The orchestrator's heavy authoring turn for the composition write-through (C2),
   *  resolved per repo. Absent ⇒ composition is skipped (the lens boards are the surface). */
  readonly composeTurn?: (
    repoRoot: string,
  ) => ((prompt: string) => Promise<string> | string) | undefined;
  /** The board-generation id minter, derived from the landed patchset so re-drafting
   *  the same patchset shares a key and the start guard dedups. Defaults to `gen:<patchset>`. */
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
}

/** One round DISPATCH — the reviewer's dispatched asks folded into ONE work-order and
 *  handed to the workers, serialized per session (B11 cluster 4). Lighter than a full
 *  `RoundInput`: the dispatch runs the coding-agent turn over the composed work-order; the
 *  board regeneration + `RoundRecord` are `runRound`'s (invoked once its lens-pipeline
 *  collation context is wired — a follow-on, kept out of the dispatch path). */
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
  /** Run the composed work-order WATCHED LIVE (the injected coding-agent turn upstream);
   *  the runtime owns the per-session serialization + recording, never the exec. Returns
   *  the round's result so `dispatchRound` records a `RoundRecord`; a `void` return records
   *  nothing (the serializer-only path used where no round result exists). */
  // biome-ignore lint/suspicious/noConfusingVoidType: `void` is deliberate here — the union
  // accepts a worker callback that legitimately returns nothing (the record-nothing path);
  // `undefined` would reject a `Promise<void>`-returning callback.
  readonly runWorkers: (workOrder: ComposedHandoffBundle) => Promise<DispatchRoundResult | void>;
}

export interface RoundsRuntime {
  /** Run one round for a session, serialized behind any round already in flight for it. */
  runRound(input: RoundInput): Promise<RoundOutcome>;
  /** Dispatch a round's composed work-order, serialized per session behind any round already
   *  in flight for it — one round per session, the SAME serializer `runRound` uses (no second
   *  lock). Same-asks idempotency is the dispatch-command handler's (it coalesces repeats
   *  before they reach here), so the workers run once per distinct work-order. */
  dispatchRound(input: RoundDispatchInput): Promise<void>;
  /** The session's rounds ledger — every `RoundRecord` this runtime recorded, in order. */
  ledger(sessionId: string): readonly RoundRecord[];
  /** Read a minted generation by id (C15 2.3) — the ledger's `GenerationSwitcher` drills back
   *  to a round's frozen predecessor (`RoundRecord.frozenPredecessor`) through this. Absent
   *  generation (or no durable store) ⇒ `undefined`; the store throws on a corrupt file. */
  generation(id: string): Generation | undefined;
}

export function createRoundsRuntime(deps: RoundsRuntimeDeps): RoundsRuntime {
  const newGenerationId = deps.newGenerationId ?? ((patchsetId: string) => `gen:${patchsetId}`);
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

  /** Reconstruct the drafting result from durable BoardMeta (B09 F1): a fresh
   *  runtime after a restart never re-mints or re-drafts an already-drafted
   *  (session, generation) — it rebuilds the board ids + coverage/blemish metadata
   *  from the evidence on disk. The report board drafts FIRST, so any non-empty
   *  evidence includes it. */
  function reconstructFromMeta(records: readonly BoardMeta[]): {
    pipeline: LensPipelineResult;
    reportBoardId: string;
  } {
    const outcomes: LensBoardOutcome[] = records.map((m) => ({
      lens: m.lens,
      boardId: m.boardId,
      omissions: m.omissions,
      blemishes: m.blemishes,
      immutability: m.immutability,
    }));
    const report = outcomes.find((o) => o.lens === "report");
    const pipeline: LensPipelineResult = {
      boards: outcomes.filter((o) => o.lens !== "report"),
      coverage: [],
      ...(report === undefined ? {} : { report }),
    };
    return { pipeline, reportBoardId: report?.boardId ?? outcomes[0]?.boardId ?? "" };
  }

  /** Pre-mint the round's boards, resolve ports, and run the pipeline once. Lives
   *  inside the start guard so a re-entry for the same generation never re-mints or
   *  re-drafts — it returns the first run's result. */
  async function draft(
    input: RoundInput,
    boardGeneration: Generation,
  ): Promise<{ pipeline: LensPipelineResult; reportBoardId: string }> {
    const boards = deps.boardsRuntimeFor(input.repoRoot);
    const boardIds = new Map<LintTarget, string>();
    for (const target of LINT_TARGETS) boardIds.set(target, await boards.createRennetBoard());
    const boardIdFor = (lens: LintTarget): string => {
      const id = boardIds.get(lens);
      if (id === undefined) throw new Error(`rounds: no board minted for ${lens}`);
      return id;
    };

    const [claudePort, codexExecutor] = await Promise.all([
      deps.resolveClaudePort(input.repoRoot),
      deps.resolveCodexExecutor(input.repoRoot),
    ]);
    const composeTurn = deps.composeTurn?.(input.repoRoot);
    const persistBoardMeta = deps.persistBoardMeta;

    // ── The live progress mapping (C15 3.1) ──
    // Two pipeline callbacks carry the real regeneration timeline: `persistBoardMeta`
    // fires as each board's draft lands (per-lens progress, in order), and
    // `onBoardArrival` fires once the board is announced — the report inline and ahead
    // of the lenses, the lenses together after cross-lens coverage, each carrying its
    // delta verdict. Both are wrapped here so the round's own sink sees them without the
    // pipeline learning about the wire.
    const onProgress = input.onProgress;
    const lanes =
      onProgress === undefined
        ? undefined
        : createRegenerationLanes((rows) => onProgress({ type: "lens", lanes: [...rows] }));
    const runtimeArrival = deps.onBoardArrival;
    const onBoardArrival =
      runtimeArrival === undefined && lanes === undefined
        ? undefined
        : (event: BoardArrivalEvent): void => {
            runtimeArrival?.(event);
            if (lanes === undefined || onProgress === undefined) return;
            if (event.lens === "report") {
              // The report is the greeting: it announces FIRST, and the reviewer reads it
              // while the lens drafters below keep running (C1/C6 — the surface never locks).
              onProgress({ type: "report", reportBoardId: event.boardId });
              lanes.start();
              return;
            }
            lanes.arrived(event.lens, event.carried);
          };

    const pipeline = await runLensPipeline({
      claudePort,
      codexExecutor,
      repoRoot: input.repoRoot,
      deltaPacket: input.deltaPacket,
      hunks: input.hunks,
      lintContextFor: input.lintContextFor,
      readPrompt: deps.readPrompt,
      whiteboard: new WhiteboardClient(boards.service),
      boardIdFor,
      ...(onBoardArrival === undefined ? {} : { onBoardArrival }),
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
                generation: boardGeneration.id,
              });
            },
          }),
      ...(input.previous === undefined ? {} : { previous: input.previous }),
      ...(composeTurn === undefined ? {} : { composeTurn }),
      ...(input.reviewDraftLintCtx === undefined
        ? {}
        : { reviewDraftLintCtx: input.reviewDraftLintCtx }),
      ...(input.curationFeedback === undefined ? {} : { curationFeedback: input.curationFeedback }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return { pipeline, reportBoardId: boardIdFor("report") };
  }

  async function runOnce(input: RoundInput): Promise<RoundOutcome> {
    // Run the dispatched work watched live, then regenerate over what it produced.
    const worked = await input.runWorkers();
    const landed = worked.patchsetId !== undefined;
    // Code moved ⇒ mint a successor generation; else re-report against the existing
    // one. F8: two rounds that land NOTHING share `previousGeneration.id`, so they
    // share the (session, generation) key — the second's draft dedups to the first's
    // boards (the in-memory guard, or the durable reconstruction below after a
    // restart). Intended: no code moved ⇒ no new generation ⇒ the same boards re-reported.
    const boardGeneration = landed
      ? mintGeneration(newGenerationId(worked.patchsetId as string), worked.patchsetId as string)
      : input.previousGeneration;

    // Durable idempotency across the crash boundary (F1): a fresh runtime after a
    // restart has an EMPTY in-memory guard, so the guard alone would re-draft (12
    // boards). The truth is the BoardMeta already on disk for this (session,
    // generation): if it exists, reconstruct the drafted boards from it and never
    // re-mint/re-draft. The guard stays the same-process fast path; this durable
    // check is what survives a restart. (Absent read seam ⇒ guard-only, no restart proof.)
    const durableEvidence =
      deps.loadDraftedBoards?.(input.repoRoot, input.session.id, boardGeneration.id) ?? [];
    const { pipeline, reportBoardId } =
      durableEvidence.length > 0
        ? reconstructFromMeta(durableEvidence)
        : await guard.start(input.session.id, boardGeneration.id, () =>
            draft(input, boardGeneration),
          );

    // The round-report seat's board, or the pre-minted report board id when the seat
    // wrote nothing — always a valid id, so the `RoundRecord` is never unrepresentable.
    const reportBoard = pipeline.report?.boardId ?? reportBoardId;
    // The frozen predecessor id (C15 2.2, un-parks C09 F3): when the code moved, the prior
    // generation freezes and its id is the earlier generation the ledger's switcher drills
    // back to. Absent on a no-move round — honestly, there is no distinct predecessor.
    const record: RoundRecord = {
      asksDispatched: [...input.asksDispatched],
      workerCommitRange: { from: worked.commitRange.from, to: worked.commitRange.to },
      ...(landed ? { mintedPatchsetGeneration: boardGeneration.id } : {}),
      boardGeneration: boardGeneration.id,
      reportBoard,
      ...(landed ? { frozenPredecessor: input.previousGeneration.id } : {}),
    };
    const records = ledger.get(input.session.id) ?? [];
    records.push(record);
    ledger.set(input.session.id, records);
    // Reconcile to ONE durable record (C15 2.2): this real-generation record supersedes the
    // dispatch path's ROUND_NO_REGEN placeholder for the same round (same worker commit
    // range), keeping the placeholder's checkpoint diff/outcome. Absent store ⇒ in-memory only.
    deps.recordRound?.(input.session.id, record);

    // Persist the generations this round minted (C15 2.1) so the frozen prior survives a
    // restart as a drill-down. The live successor carries its lens board ids; the prior
    // freezes iff the code moved.
    const liveSuccessor = withLensBoards(boardGeneration, pipeline);
    await deps.persistGeneration?.(liveSuccessor);
    const frozenPrevious = landed ? freezeGeneration(input.previousGeneration) : undefined;
    if (frozenPrevious !== undefined) await deps.persistGeneration?.(frozenPrevious);

    // The round composed (C15 3.1): the terminal event the run machine gates **View the
    // New Boards** on. Emitted with the generation the reveal lands on, so the control
    // appears at real composition — never as a disabled button waiting for a flag.
    input.onProgress?.({ type: "composed", generation: liveSuccessor.id });

    return {
      record,
      boardGeneration: liveSuccessor,
      ...(frozenPrevious === undefined ? {} : { frozenPrevious }),
      pipeline,
    };
  }

  /** `runOnce`, with the round's live channel closed HONESTLY on a throw: a regeneration
   *  that dies emits a terminal `failed` rather than leaving the run machine mid-phase
   *  forever (a silent stall reads as "still working", which is a lie). The error still
   *  propagates — the caller decides what a failed regeneration means. */
  async function runOnceReported(input: RoundInput): Promise<RoundOutcome> {
    try {
      return await runOnce(input);
    } catch (error) {
      input.onProgress?.({
        type: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  return {
    runRound(input: RoundInput): Promise<RoundOutcome> {
      return enqueue(input.session.id, () => runOnceReported(input));
    },
    dispatchRound(input: RoundDispatchInput): Promise<void> {
      return enqueue(input.session.id, async () => {
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
          asksDispatched: input.workOrder.tasks.flatMap((task) => task.asks.map((ask) => ask.id)),
          workerCommitRange: {
            from: result.workerCommitRange.from,
            to: result.workerCommitRange.to,
          },
          boardGeneration: ROUND_NO_REGEN,
          reportBoard: ROUND_NO_REGEN,
          outcome: result.outcome,
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
          throw new Error("round worker turn failed");
        }
      });
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
