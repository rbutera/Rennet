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
//   4. RECORD the round — a `RoundRecord` pinning asks, worker commit range,
//      minted generation, board generation, and the round-report board; the
//      rounds ledger is `RoundRecord[]` data (no UI — C9 out of scope).
//
// B09 does NOT edit the pipeline's pure logic: the round-report drafts FIRST and
// gates the regeneration, per-board arrival powers the reveal, and the durable
// `persistBoardMeta` are all the pipeline's own behavior (`isRound` derived from
// `deltaPacket.successorAccount`) — this runtime only wires the seams.
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto";
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
  type DraftBoard,
  type Generation,
  LENS_KINDS,
  type LensKind,
  type RoundRecord,
  type SessionModel,
} from "@rennet/protocol";
import type { BoardsRuntime } from "../boards/boards-runtime";
import { PipelineStartGuard } from "../session/pipeline-guard";
import {
  type BoardArrivalEvent,
  type BoardMeta,
  type LensPipelineResult,
  type PromptReader,
  runLensPipeline,
} from "./lens-pipeline";

/** The boards one round drafts: the five lenses plus the round-report seat. */
const LINT_TARGETS: readonly LintTarget[] = [...LENS_KINDS, "report"];

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
  /** The durable board-meta store's write (B08 finding 3); absent ⇒ metadata is result-only. */
  readonly persistBoardMeta?: (repoRoot: string, meta: BoardMeta) => void | Promise<void>;
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
}

export interface RoundsRuntime {
  /** Run one round for a session, serialized behind any round already in flight for it. */
  runRound(input: RoundInput): Promise<RoundOutcome>;
  /** The session's rounds ledger — every `RoundRecord` this runtime recorded, in order. */
  ledger(sessionId: string): readonly RoundRecord[];
}

export function createRoundsRuntime(deps: RoundsRuntimeDeps): RoundsRuntime {
  const newGenerationId = deps.newGenerationId ?? ((patchsetId: string) => `gen:${patchsetId}`);
  const guard = new PipelineStartGuard();
  const ledger = new Map<string, RoundRecord[]>();
  // Per-session promise tails — one round in flight per session (the SessionTurnLoop
  // pattern). The stored tail swallows rejection so a failed round never wedges the
  // queue; the returned promise carries the real outcome.
  const tails = new Map<string, Promise<unknown>>();

  /** Pre-mint the round's boards, resolve ports, and run the pipeline once. Lives
   *  inside the start guard so a re-entry for the same generation never re-mints or
   *  re-drafts — it returns the first run's result. */
  async function draft(
    input: RoundInput,
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
      ...(deps.onBoardArrival === undefined ? {} : { onBoardArrival: deps.onBoardArrival }),
      ...(persistBoardMeta === undefined
        ? {}
        : { persistBoardMeta: (meta: BoardMeta) => persistBoardMeta(input.repoRoot, meta) }),
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
    // Code moved ⇒ mint a successor generation; else re-report against the existing one.
    const boardGeneration = landed
      ? mintGeneration(newGenerationId(worked.patchsetId as string), worked.patchsetId as string)
      : input.previousGeneration;

    const { pipeline, reportBoardId } = await guard.start(
      input.session.id,
      boardGeneration.id,
      () => draft(input),
    );

    // The round-report seat's board, or the pre-minted report board id when the seat
    // wrote nothing — always a valid id, so the `RoundRecord` is never unrepresentable.
    const reportBoard = pipeline.report?.boardId ?? reportBoardId;
    const record: RoundRecord = {
      asksDispatched: [...input.asksDispatched],
      workerCommitRange: { from: worked.commitRange.from, to: worked.commitRange.to },
      ...(landed ? { mintedPatchsetGeneration: boardGeneration.id } : {}),
      boardGeneration: boardGeneration.id,
      reportBoard,
    };
    const records = ledger.get(input.session.id) ?? [];
    records.push(record);
    ledger.set(input.session.id, records);

    return {
      record,
      boardGeneration: withLensBoards(boardGeneration, pipeline),
      ...(landed ? { frozenPrevious: freezeGeneration(input.previousGeneration) } : {}),
      pipeline,
    };
  }

  return {
    runRound(input: RoundInput): Promise<RoundOutcome> {
      const sessionId = input.session.id;
      const prior = tails.get(sessionId) ?? Promise.resolve();
      const run = prior.then(() => runOnce(input));
      tails.set(
        sessionId,
        run.catch(() => undefined),
      );
      return run;
    },
    ledger(sessionId: string): readonly RoundRecord[] {
      return ledger.get(sessionId) ?? [];
    },
  };
}
