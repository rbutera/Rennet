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

import { type DesignArtifactSet, WhiteboardClient } from "@rennet/adapters";
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
  generationIdForPatchset,
  LENS_KINDS,
  type LensKind,
  type LensLane,
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
  createDesignCoverageMapper,
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
 * The pipeline drafts the lenses in `LENS_KINDS` order, one at a time, so "this lens
 * finished" (its board meta persists) is also "the next lens started" — the sequence is
 * read off the real run, never guessed from a clock.
 */
function createRegenerationLanes(emit: (lanes: readonly LensLane[]) => void) {
  const lanes = new Map<LensKind, LensLane>(
    LENS_KINDS.map((lens) => [lens, { id: lens, label: LENS_LANE_LABEL[lens], status: "queued" }]),
  );
  const snapshot = (): readonly LensLane[] => [...lanes.values()];
  /** Replace a lane WHOLE — the state is a union, so a lane moves from one legal shape to
   *  another rather than being patched into an in-between that carries the wrong fields. */
  const set = (lens: LensKind, next: LaneState): void => {
    if (lanes.has(lens)) lanes.set(lens, { id: lens, label: LENS_LANE_LABEL[lens], ...next });
  };
  return {
    /** The first drafter is under way (the report gated the regeneration and landed). */
    start(): void {
      const first = LENS_KINDS[0];
      if (first !== undefined) set(first, { status: "running" });
      emit(snapshot());
    },
    /** A lens board's draft landed; the next lens in the pipeline's order is now running.
     *  The lane reads `drafted`, NOT `done`: cross-lens coverage has not run and the delta
     *  verdict is not known yet, and a settled lane without its verdict is exactly the
     *  in-between state the union refuses to represent. */
    drafted(lens: LensKind): void {
      set(lens, { status: "drafted" });
      const next = LENS_KINDS[LENS_KINDS.indexOf(lens) + 1];
      if (next !== undefined && lanes.get(next)?.status === "queued")
        set(next, { status: "running" });
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
      const next = LENS_KINDS[LENS_KINDS.indexOf(lens) + 1];
      if (next !== undefined && lanes.get(next)?.status === "queued")
        set(next, { status: "running" });
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
  const absentLenses: Partial<Record<LensKind, "no-material">> = { ...gen.absentLenses };
  for (const o of result.boards) {
    if (o.lens === "report") continue;
    if (o.boardId !== undefined) {
      lensBoards[o.lens] = o.boardId;
      delete absentLenses[o.lens];
    } else if (o.absence !== undefined) {
      absentLenses[o.lens] = o.absence;
      delete lensBoards[o.lens];
    }
  }
  if (Object.keys(absentLenses).length > 0) return { ...gen, lensBoards, absentLenses };
  const generationWithoutAbsences = { ...gen };
  delete generationWithoutAbsences.absentLenses;
  return { ...generationWithoutAbsences, lensBoards };
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

/** The drafters' own failure reasons, for the terminal event a board-less round emits. */
function failureReasons(pipeline: LensPipelineResult): string {
  const reasons = [pipeline.report, ...pipeline.boards].flatMap((outcome) =>
    outcome === undefined || outcome.boardId !== undefined || outcome.absence !== undefined
      ? []
      : [`${outcome.lens}: ${outcome.failure ?? "no board"}`],
  );
  return reasons.length > 0 ? reasons.join("; ") : "no drafter reported a reason";
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
  /** Thread ids of the asks this round dispatched (pinned into the `RoundRecord`). */
  readonly asksDispatched: readonly string[];
  /** Run the dispatched work WATCHED LIVE — the injected worker turn (a coding-agent
   *  loop upstream); this runtime owns serialization + recording, not the exec. */
  readonly runWorkers: () => Promise<WorkerReturn>;
  /** The round delta packet (carries `successorAccount`, so the pipeline drafts as a round). */
  readonly deltaPacket: DeltaPacket;
  readonly hunks: readonly LintHunk[];
  readonly lintContextFor: (lens: LintTarget) => LintContext;
  /** Deterministically discovered Design artifacts; null means discovery succeeded with no spec. */
  readonly designArtifacts?: DesignArtifactSet | null;
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
  /**
   * The composed review draft's citation grounding. REQUIRED (W5): an absent one
   * grounds the composition lint on an empty inventory, so every real `path:line`
   * the draft cites reports "does not resolve" on the surface the reviewer reads.
   * `assembleRoundCollation` builds it from the same head inventory as the boards,
   * so a caller that spreads a `RoundCollation` already carries it.
   */
  readonly reviewDraftLintCtx: RegisterLintContext;
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
   *  the same patchset shares a key and the start guard dedups. Defaults to the protocol's
   *  own `generationIdForPatchset` — the spelling the client reads boards by. */
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
  /** The live round-progress sink — the SAME channel `runRound` reports on. Present ⇒ a
   *  dispatch that dies emits a terminal `failed`; absent ⇒ no live channel, same round. */
  readonly onProgress?: (event: RoundEvent) => void;
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
  // The default is the PROTOCOL's, not a local literal: the client addresses the live
  // boards by spelling the same id (`generationIdForPatchset(review.activePatchsetId)`),
  // and `board.read` matches it exactly, so the two spellings have to be one function.
  const newGenerationId = deps.newGenerationId ?? generationIdForPatchset;
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
   *  (session, generation) — it rebuilds the board ids + per-board blemish metadata
   *  from the evidence on disk. The report board drafts FIRST, so any non-empty
   *  evidence includes it.
   *
   *  COVERAGE IS OMITTED, not emptied. Cross-lens coverage is computed from the drafted
   *  boards (which hunks each one teaches) and the boards are not in the durable meta —
   *  so a restored round CANNOT know its coverage picture. Reporting `[]` here said "this
   *  round covered every hunk", which is a claim the reconstruction never verified; the
   *  honest answer is that it cannot say. */
  function reconstructFromMeta(records: readonly BoardMeta[]): LensPipelineResult {
    const outcomes: LensBoardOutcome[] = records.map((m) => ({
      lens: m.lens,
      boardId: m.boardId,
      omissions: m.omissions,
      blemishes: m.blemishes,
      immutability: m.immutability,
    }));
    const report = outcomes.find((o) => o.lens === "report");
    return {
      boards: outcomes.filter((o) => o.lens !== "report"),
      ...(report === undefined ? {} : { report }),
    };
  }

  /** Pre-mint the round's boards, resolve ports, and run the pipeline once. Lives
   *  inside the start guard so a re-entry for the same generation never re-mints or
   *  re-drafts — it returns the first run's result. */
  async function draft(
    input: RoundInput,
    boardGeneration: Generation,
  ): Promise<LensPipelineResult> {
    if (input.designArtifacts === null) {
      await deps.persistGeneration?.({
        ...boardGeneration,
        absentLenses: {
          ...boardGeneration.absentLenses,
          design: "no-material",
        },
      });
    }
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
    const earlyAbsentLenses: Partial<Record<LensKind, "no-material">> = {
      ...boardGeneration.absentLenses,
    };
    const onLensAbsence =
      lanes === undefined && deps.persistGeneration === undefined
        ? undefined
        : async (lens: LensKind, reason: "no-material"): Promise<void> => {
            lanes?.absent(
              lens,
              reason === "no-material" ? "No spec artifacts were discovered." : reason,
            );
            earlyAbsentLenses[lens] = reason;
            await deps.persistGeneration?.({
              ...boardGeneration,
              absentLenses: { ...earlyAbsentLenses },
            });
          };

    const pipeline = await runLensPipeline({
      claudePort,
      codexExecutor,
      repoRoot: input.repoRoot,
      deltaPacket: input.deltaPacket,
      hunks: input.hunks,
      lintContextFor: input.lintContextFor,
      ...(input.designArtifacts === undefined
        ? {}
        : {
            designArtifacts: input.designArtifacts,
            ...(claudePort === null
              ? {}
              : { mapDesignCoverage: createDesignCoverageMapper(claudePort, input.repoRoot) }),
          }),
      readPrompt: deps.readPrompt,
      whiteboard: new WhiteboardClient(boards.service),
      boardIdFor,
      ...(onBoardArrival === undefined ? {} : { onBoardArrival }),
      ...(onLensAbsence === undefined ? {} : { onLensAbsence }),
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
      reviewDraftLintCtx: input.reviewDraftLintCtx,
      ...(input.curationFeedback === undefined ? {} : { curationFeedback: input.curationFeedback }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    // A drafter that produced no board settles its lane as failed. Without this the lane
    // sits at `queued`/`running` after the round is over — the surface reads "still
    // working" forever, which is the same stall a silent crash leaves behind.
    for (const outcome of pipeline.boards) {
      if (outcome.boardId !== undefined || outcome.lens === "report") continue;
      if (outcome.absence !== undefined) continue;
      lanes?.failed(outcome.lens, outcome.failure ?? "the drafter produced no board");
    }
    return pipeline;
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
    // Nothing landed and no prior generation ⇒ this is the session's FIRST generation over
    // the patchset the drafters are reading; mint it from that patchset rather than from a
    // predecessor that does not exist.
    const boardGeneration = landed
      ? (deps.loadGeneration?.(newGenerationId(worked.patchsetId as string)) ??
        mintGeneration(newGenerationId(worked.patchsetId as string), worked.patchsetId as string))
      : (input.previousGeneration ??
        mintGeneration(
          newGenerationId(input.deltaPacket.patchset.id),
          input.deltaPacket.patchset.id,
        ));

    // Durable idempotency across the crash boundary (F1): a fresh runtime after a
    // restart has an EMPTY in-memory guard, so the guard alone would re-draft (12
    // boards). The truth is the BoardMeta already on disk for this (session,
    // generation): if it exists, reconstruct the drafted boards from it and never
    // re-mint/re-draft. The guard stays the same-process fast path; this durable
    // check is what survives a restart. (Absent read seam ⇒ guard-only, no restart proof.)
    const durableEvidence =
      deps.loadDraftedBoards?.(input.repoRoot, input.session.id, boardGeneration.id) ?? [];
    const pipeline =
      durableEvidence.length > 0
        ? reconstructFromMeta(durableEvidence)
        : await guard.start(input.session.id, boardGeneration.id, () =>
            draft(input, boardGeneration),
          );

    // The round-report seat's board, or the `ROUND_NO_REGEN` marker when the seat wrote
    // nothing. Every board id is PRE-MINTED before the drafters run, so recording the
    // pre-minted id here would file an empty board as the round's report — a ledger row
    // pointing at a document nobody wrote. Honest absence is the protocol's own contract
    // for this field ("`ROUND_NO_REGEN` when the round drafted no report board").
    const reportBoard = pipeline.report?.boardId ?? ROUND_NO_REGEN;
    // The boards this round actually WROTE (report included) — the difference between a
    // regeneration and a round that only reports its own failures.
    const drafted = [pipeline.report, ...pipeline.boards].filter(
      (outcome) => outcome?.boardId !== undefined,
    );
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
      workerCommitRange: { from: worked.commitRange.from, to: worked.commitRange.to },
      ...(landed ? { mintedPatchsetGeneration: boardGeneration.id } : {}),
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
    const liveSuccessor = withLensBoards(boardGeneration, pipeline);
    await deps.persistGeneration?.(liveSuccessor);
    const frozenPrevious = predecessor === undefined ? undefined : freezeGeneration(predecessor);
    if (frozenPrevious !== undefined) await deps.persistGeneration?.(frozenPrevious);

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
    // A round where EVERY drafter failed composed nothing: there are no new boards to
    // reveal, so it terminates on `failed` carrying the drafters' own reasons. Announcing
    // "composed" over an empty generation would put a reveal control in front of a
    // regeneration that does not exist.
    if (drafted.length > 0) {
      input.onProgress?.({ type: "composed", generation: liveSuccessor.id });
    } else {
      input.onProgress?.({
        type: "failed",
        reason: `The regeneration drafted no boards: ${failureReasons(pipeline)}`,
      });
    }

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
