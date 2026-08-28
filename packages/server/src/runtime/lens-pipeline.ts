import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WhiteboardClient } from "@rennet/adapters";
import { councilSeatTurn } from "@rennet/adapters";
import {
  assertCoverage,
  type CodexExecutor,
  carriedElementIds,
  DEFAULT_SEAT_LABELS,
  type DeltaPacket,
  type HarnessPort,
  type HarnessTurnResult,
  isCarriedForward,
  type LintContext,
  type LintHunk,
  type LintTarget,
  lintReviewDraft,
  NO_CONCERN_ANSWER,
  type Omission,
  type RegisterLintContext,
  reconcileFindings,
  stampDeltas,
  validateDraft,
} from "@rennet/core";
import {
  LENS_PROMPT_FILES,
  POST_PROCESS_FILE,
  REVIEW_DRAFT_VOICE_FILE,
  ROUND_REPORT_FILE,
  renderLayer,
} from "@rennet/prompts";
import {
  type CouncilJobId,
  type CouncilResolveContext,
  type DraftBoard,
  DraftBoardSchema,
  type DraftElement,
  type FindingAgreement,
  type FindingElement,
  LENS_KINDS,
  type LensKind,
  parseDraft,
  type Violation,
} from "@rennet/protocol";
import { z } from "zod";

/**
 * The lens drafting pipeline SCHEDULER (#464 + #493 + #486, B08 cluster 5): the
 * `server/runtime/` home the packet names, the direct sibling of B06's
 * `knowledge-swarm.ts`. It seeds one drafter harness session per lens IN THE PR
 * WORKTREE with the inlined DeltaPacket (B5) + the lens prompt (`@rennet/prompts`)
 * + the host board schema (D1), validates each structured return through the
 * cluster-3 loop (`validateDraft` over `parseDraft`/`lint`), runs the
 * `board-post-process` editor pass (D2 postProcess seam), and — as the SOLE op
 * writer — writes the validated board through `whiteboard-client` (the drafters
 * never call whiteboard tools). Council-routed: every seat resolves through
 * `resolveAssignment` on the RESOLVED harness (Claude port / Codex utility
 * executor), exactly the B06 `councilSeatTurn` precedent.
 *
 * It is PURE over injected seams — the harness ports, a `readPrompt` file seam,
 * and the whiteboard writer — so the gate exercises the real path with a fake
 * `runTurn` and never makes a live model call (D-seam, like B06's swarm tests).
 *
 * ── Wiring points (packet 5.1 "record the wiring point in the ledger") ──
 *   - postProcess (validate.ts seam, identity by default) ← the REAL
 *     `board-post-process` editor pass (`POST_PROCESS_FILE`). Not a parallel
 *     gate runner — the one seam cluster 3 left.
 *   - compositionGate (validate.ts per-board seam) STAYS no-op; the cross-lens
 *     `assertCoverage(boards, hunks)` (cluster 4) runs ONCE over the frozen board
 *     set here, after every lens freezes — never per board.
 */

// ── The board output schema (the host schema the drafter's session is constrained to) ──

let cachedBoardSchema: unknown;
/**
 * The JSON-schema view of the frozen `DraftBoardSchema`, derived once (never
 * hand-authored — reconciliation 2/F4). Passed to the harness session as the
 * output schema AND inlined into the drafter prompt as the host schema (D1). A
 * derivation failure falls back to a permissive object schema so a runtime
 * quirk never blocks drafting (Rule Zero).
 */
export function boardOutputSchema(): unknown {
  if (cachedBoardSchema !== undefined) return cachedBoardSchema;
  try {
    cachedBoardSchema = z.toJSONSchema(DraftBoardSchema, { io: "output" });
  } catch {
    cachedBoardSchema = { type: "object", properties: { elements: { type: "array" } } };
  }
  return cachedBoardSchema;
}

// ── Draft → board ops (the host writes ops on the drafter's behalf, D2) ──

/** The element ids an element references (a string field, or array entry, that is a live element id). */
function referencedIds(el: DraftElement, liveIds: ReadonlySet<string>): string[] {
  const refs: string[] = [];
  for (const value of Object.values(el.data as Record<string, unknown>)) {
    if (typeof value === "string" && liveIds.has(value)) refs.push(value);
    else if (Array.isArray(value)) {
      for (const v of value) if (typeof v === "string" && liveIds.has(v)) refs.push(v);
    }
  }
  return refs;
}

/**
 * Project a validated draft board into the flat `create` ops the whiteboard
 * client applies. The wire element shape `{ id, kind, data }` IS the draft
 * element shape, so this is a per-element map — the host, never the drafter, is
 * the op writer (`whiteboard-client` is the sole writer, B04).
 *
 * The ops are TOPOLOGICALLY ORDERED — a referenced element (a `code_ref`) is
 * created before the element that cites it (a `finding` whose `code` names it),
 * because the board service validates references in batch order and rejects a
 * create that names a not-yet-created element as a `bad-ref` (finding 2). The
 * drafter's authoring order is not that order, so a finding-before-its-code_ref
 * board would otherwise be rejected wholesale while the pipeline announced
 * success. Cycles (which the frozen schema does not admit) fall back to source
 * order rather than dropping an element.
 */
export function draftToOps(
  board: DraftBoard,
): { op: "create"; element: DraftBoard["elements"][number] }[] {
  const byId = new Map(board.elements.map((el) => [el.id, el]));
  const liveIds = new Set(byId.keys());
  const ordered: DraftElement[] = [];
  const done = new Set<string>();
  const onStack = new Set<string>();
  const visit = (el: DraftElement): void => {
    if (done.has(el.id) || onStack.has(el.id)) return; // done, or a cycle — break
    onStack.add(el.id);
    for (const refId of referencedIds(el, liveIds)) {
      const dep = byId.get(refId);
      if (dep !== undefined && dep.id !== el.id) visit(dep);
    }
    onStack.delete(el.id);
    done.add(el.id);
    ordered.push(el);
  };
  for (const el of board.elements) visit(el);
  return ordered.map((element) => ({ op: "create", element }));
}

// ── Flagged dual seat: reconcile two boards' findings (J1/J2, cluster 5.2) ──

/** One per-model concurrence tally, the board `finding.data.concurrence` element shape. */
interface Concurrence {
  readonly model: string;
  readonly agree: number;
  readonly total: number;
}

/** The finding elements of a board, in order. */
function boardFindings(board: DraftBoard): DraftElement[] {
  return board.elements.filter((el) => el.kind === "finding");
}

/**
 * Synthesize the location anchor a board finding cites, so two seats' findings
 * over the SAME code region reconcile as concurring. Built from the finding's
 * first `code_ref` (path + new-image span) as a `rennet:file/…#L…` anchor; a
 * finding with no citation gets a per-id `rennet:doc/<id>` anchor that can never
 * match across seats (an uncited finding cannot be located to concur — honest).
 */
export function synthAnchor(finding: DraftElement, board: DraftBoard): string {
  const code = (finding.data as { code?: unknown }).code;
  const firstRef = Array.isArray(code) ? code.find((c) => typeof c === "string") : undefined;
  if (typeof firstRef === "string") {
    const ref = board.elements.find((el) => el.id === firstRef && el.kind === "code_ref");
    const d = ref?.data as { path?: unknown; start_line?: unknown; end_line?: unknown } | undefined;
    if (d && typeof d.path === "string" && typeof d.start_line === "number") {
      const end = typeof d.end_line === "number" ? d.end_line : d.start_line;
      return `rennet:file/${d.path}#L${d.start_line}-L${end}`;
    }
  }
  return `rennet:doc/${finding.id}`;
}

/** Project a board finding into the wire `FindingElement` `reconcileFindings` folds. */
export function toFindingElement(finding: DraftElement, board: DraftBoard): FindingElement {
  const data = finding.data as { concern?: unknown; severity?: unknown };
  return {
    findingId: finding.id,
    anchor: synthAnchor(finding, board),
    summary: typeof data.concern === "string" ? data.concern : "",
    severity:
      data.severity === "high" || data.severity === "medium" || data.severity === "low"
        ? data.severity
        : "medium",
    agreement: { kind: "concur", agree: 1, total: 1 },
  };
}

/** Fold a reconciled agreement into the board's per-model concurrence tallies. */
export function foldConcurrence(
  agreement: FindingAgreement,
  labels: { a: string; b: string },
): Concurrence[] {
  if (agreement.kind === "concur") {
    return [
      { model: labels.a, agree: 1, total: 1 },
      { model: labels.b, agree: 1, total: 1 },
    ];
  }
  return agreement.answers.map((ans) => ({
    model: ans.model,
    agree: ans.answer === NO_CONCERN_ANSWER ? 0 : 1,
    total: 1,
  }));
}

/** Merge accumulated skippedHunks from both boards (dedup by hunk id). */
function mergeSkips(boardA: DraftBoard, boardB: DraftBoard): { hunk: string; reason: string }[] {
  const read = (b: DraftBoard) =>
    ((b as { skippedHunks?: unknown }).skippedHunks ?? []) as { hunk: string; reason: string }[];
  const seen = new Set<string>();
  const out: { hunk: string; reason: string }[] = [];
  for (const s of [...read(boardA), ...read(boardB)]) {
    if (Array.isArray(s) || s?.hunk === undefined || seen.has(s.hunk)) continue;
    seen.add(s.hunk);
    out.push(s);
  }
  return out;
}

/**
 * Namespace every element id in a board (and every INTRA-board reference to it)
 * under `prefix`, so two independently-drafted seats can never share an id. The
 * two flagged seats mint ids independently, so both may author a `c1` for
 * DIFFERENT code — without this, seat B's finding would resolve its `code:["c1"]`
 * against seat A's `c1` after the merge (finding 7). Hunk ids in `skippedHunks`
 * are patchset ids, not element ids, so they are left untouched. Pure.
 */
export function namespaceBoard(board: DraftBoard, prefix: string): DraftBoard {
  const ids = new Set(board.elements.map((el) => el.id));
  const rename = (v: string): string => (ids.has(v) ? prefix + v : v);
  const elements = board.elements.map((el) => {
    const data = el.data as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(data)) {
      if (typeof val === "string") next[k] = rename(val);
      else if (Array.isArray(val))
        next[k] = val.map((x) => (typeof x === "string" ? rename(x) : x));
      else next[k] = val;
    }
    return { ...el, id: prefix + el.id, data: next } as DraftElement;
  });
  return { ...(board as object), elements } as DraftBoard;
}

/**
 * Reconcile two flagged-seat boards into one: `reconcileFindings` folds their
 * findings by location (per-finding cross-model concurrence, J2), a matched pair
 * collapses to the clearer one with both models' concurrence, a solo carries the
 * raising model's concurrence. Seat B's ids are NAMESPACED first (finding 7), so
 * a seat can never cite the other seat's code; matching is by synthesized
 * location anchor, not id, so namespacing does not disturb it. Non-finding
 * elements then union by id (now collision-free); skippedHunks merge. Pure.
 */
export function reconcileFlaggedBoards(
  boardArg: DraftBoard,
  boardBArg: DraftBoard,
  labels: { a: string; b: string },
): DraftBoard {
  const boardA = boardArg;
  const boardB = namespaceBoard(boardBArg, "b:");
  const aFindings = boardFindings(boardA);
  const bFindings = boardFindings(boardB);
  const reconciled = reconcileFindings(
    aFindings.map((el) => toFindingElement(el, boardA)),
    bFindings.map((el) => toFindingElement(el, boardB)),
    labels,
  );
  const byId = new Map<string, { agreement: FindingAgreement }>(
    reconciled.map((r) => [r.findingId, { agreement: r.agreement }]),
  );

  const merged = (el: DraftElement): DraftElement => {
    const r = byId.get(el.id);
    if (r === undefined) return el;
    return {
      ...el,
      data: { ...(el.data as object), concurrence: foldConcurrence(r.agreement, labels) },
    } as DraftElement;
  };

  const placed = new Set<string>();
  const elements: DraftElement[] = [];
  for (const el of boardA.elements) {
    if (el.kind === "finding" && !byId.has(el.id)) continue; // collapsed into seat B's kept partner
    elements.push(el.kind === "finding" ? merged(el) : el);
    placed.add(el.id);
  }
  for (const el of boardB.elements) {
    if (placed.has(el.id)) continue;
    if (el.kind === "finding" && !byId.has(el.id)) continue; // collapsed into seat A's kept partner
    elements.push(el.kind === "finding" ? merged(el) : el);
    placed.add(el.id);
  }

  return {
    ...(boardA as object),
    elements,
    skippedHunks: mergeSkips(boardA, boardB),
  } as DraftBoard;
}

/** Stamp single-seat concurrence on every finding (the honest degrade — one harness only). */
export function stampSingleSeatConcurrence(board: DraftBoard, label: string): DraftBoard {
  const elements = board.elements.map((el) =>
    el.kind === "finding"
      ? ({
          ...el,
          data: { ...(el.data as object), concurrence: [{ model: label, agree: 1, total: 1 }] },
        } as DraftElement)
      : el,
  );
  return { ...(board as object), elements } as DraftBoard;
}

// ── Composition authoring (C2, cluster 5.4) ──

/** The authored review draft — connective prose plus the mechanical carry facts. */
export interface ComposeResult {
  /** The write-through authored connective prose in the reviewer's first-person register. */
  readonly prose: string;
  /** The mechanically-carried element ids per lens (cluster-4 verbatim carry). */
  readonly carried: ReadonlyMap<LintTarget, ReadonlySet<string>>;
  /** The review-draft register screen (L3/L4/L7) — visible, never blocking (Rule Zero). */
  readonly violations: readonly Violation[];
}

export interface ComposeInput {
  /** The frozen lens boards — the reading surface (C3: compose emits no sixth board). */
  readonly boards: ReadonlyMap<LintTarget, DraftBoard>;
  /** The prior generation's boards, for the mechanical verbatim-carry computation. */
  readonly previous?: ReadonlyMap<LintTarget, DraftBoard>;
  /** `REVIEW_DRAFT_VOICE_FILE` contents — the write-through post-process steps in the review register. */
  readonly voicePromptText: string;
  /** The orchestrator's free-text authoring turn (the composition seat). */
  readonly authorTurn: (prompt: string) => Promise<string> | string;
  /** The review-draft register lint context (citation files + R20 identifiers). */
  readonly lintCtx: RegisterLintContext;
  /** Curation feedback threaded from the prior generation (C2) — inlined into the authoring prompt. */
  readonly curationFeedback?: string;
}

/** Assemble the composition authoring prompt: the voice rules + the boards + prior curation. */
export function renderComposePrompt(input: ComposeInput): string {
  const context = JSON.stringify({
    boards: [...input.boards.values()],
    ...(input.curationFeedback === undefined ? {} : { curationFeedback: input.curationFeedback }),
  });
  return `${renderLayer("payload", input.voicePromptText)}\n\n${renderLayer("context", context)}`;
}

/**
 * The authored composition (C2): the orchestrator applies the MECHANICAL compose
 * (cluster-4 verbatim carry; delta stamps already live on each board's sections)
 * plus the WRITE-THROUGH authored connective prose on the versioned composition
 * prompt (`REVIEW_DRAFT_VOICE_FILE`, reconciliation 5) — in the reviewer's
 * first-person register, the voice prompt's own post-process steps applied. The
 * prose is screened by the review-draft register lint (`lintReviewDraft`),
 * visible-never-blocking. Curation feedback threads in via `curationFeedback`.
 * Pure over the injected authoring turn — no live model in the gate.
 */
export async function composeReviewDraft(input: ComposeInput): Promise<ComposeResult> {
  const prose = await input.authorTurn(renderComposePrompt(input));
  const carried = new Map<LintTarget, ReadonlySet<string>>();
  for (const [lens, board] of input.boards) {
    const prev = input.previous?.get(lens);
    if (prev !== undefined) carried.set(lens, carriedElementIds(prev, board));
  }
  return { prose, carried, violations: lintReviewDraft(prose, input.lintCtx) };
}

// ── Prompt assembly (each turn is a fresh stateless session — carry everything) ──

/**
 * The drafter's base prompt: the lens instructions (payload) + the inlined
 * DeltaPacket and host schema (context). Every turn re-sends this — the harness
 * turn builders open a fresh session per call, so nothing may rely on prior
 * turn state.
 */
export function renderDrafterPrompt(
  promptText: string,
  packet: DeltaPacket,
  reportBoard?: DraftBoard,
): string {
  const context = JSON.stringify({
    deltaPacket: packet,
    hostSchema: boardOutputSchema(),
    // On rounds the round-report drafts FIRST and is the lens drafters' input (D3/R58).
    ...(reportBoard === undefined ? {} : { roundReport: reportBoard }),
  });
  return `${renderLayer("payload", promptText)}\n\n${renderLayer("context", context)}`;
}

/**
 * The re-draft prompt: the same base plus the failing draft and the
 * ZodError-shaped pointers the validation loop produced. The seat returns a
 * corrected board (the loop freezes passing elements, so only the pointed-at
 * elements need fixing).
 */
export function renderRetryPrompt(
  basePrompt: string,
  draft: DraftBoard,
  pointers: readonly { path: readonly (string | number)[]; message: string; ruleId?: string }[],
): string {
  const issues = pointers
    .map((p) => `- ${p.ruleId ?? "schema"} at ${JSON.stringify(p.path)}: ${p.message}`)
    .join("\n");
  const prior = renderLayer(
    "task",
    `Your previous draft did not pass. Fix ONLY these issues and return the whole board:\n${issues}\n\nPrevious draft:\n${JSON.stringify(draft)}`,
  );
  return `${basePrompt}\n\n${prior}`;
}

/** The post-process editor's prompt: its instructions plus the board to polish. */
export function renderPostProcessPrompt(promptText: string, board: DraftBoard): string {
  return `${renderLayer("payload", promptText)}\n\n${renderLayer("context", JSON.stringify({ board }))}`;
}

// ── The prompt-file reader seam (prompts is node-free; the caller resolves files) ──

/** Read a prompt file from an on-disk copy of the `@rennet/prompts` src dir. */
export type PromptReader = (file: string) => string | Promise<string>;

/** The default node reader: resolves prompt file names against `promptsSrcDir`. */
export function createNodePromptReader(promptsSrcDir: string): PromptReader {
  return (file: string) => readFileSync(join(promptsSrcDir, file), "utf8");
}

// ── The per-board arrival event (B04 broadcast; B09 R58 reveal consumes it) ──

/** One board froze and was persisted — the event that powers the progressive reveal (R58). */
export interface BoardArrivalEvent {
  readonly lens: LintTarget;
  readonly boardId: string;
  /** The frozen element count — a cheap "this board is ready" signal for the reveal. */
  readonly elementCount: number;
  /**
   * Did this board CARRY FORWARD — the regeneration changed none of its sections?
   * (C15 3.3.) Read straight off the delta stamps `stampDeltas` just wrote via
   * {@link isCarriedForward}, so the live progress channel's "carrying forward" lane
   * label and the board's own section markers are the SAME signal and cannot disagree.
   * Always `false` on a first generation (nothing to carry from).
   */
  readonly carried: boolean;
}

/**
 * A board's validation/coverage metadata (finding 3). `draftToOps` serializes only
 * a board's ELEMENTS to the whiteboard event log; its `skippedHunks` (coverage) and
 * the validation `blemishes`/`omissions`/`immutability` are board-level, live only in
 * memory, and the frozen 13-kind vocabulary has no element to carry them. This is the
 * durable home the composition root supplies (a store keyed by `boardId`), persisted
 * BEFORE a board's arrival is announced so a reader reconstructing the result never
 * sees an announced board whose coverage was lost.
 */
export interface BoardMeta {
  readonly lens: LintTarget;
  readonly boardId: string;
  readonly skippedHunks: readonly { hunk: string; reason: string }[];
  readonly blemishes: readonly Violation[];
  readonly omissions: readonly Omission[];
  readonly immutability: readonly Violation[];
}

/** Read a board's `skippedHunks` passthrough (board-level, not an element). */
function boardSkippedHunks(board: DraftBoard): { hunk: string; reason: string }[] {
  const raw = (board as { skippedHunks?: unknown }).skippedHunks;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((e) => {
    const o = (e ?? {}) as { hunk?: unknown; reason?: unknown };
    return typeof o.hunk === "string"
      ? [{ hunk: o.hunk, reason: typeof o.reason === "string" ? o.reason : "" }]
      : [];
  });
}

// ── One lens's outcome ──

export interface LensBoardOutcome {
  readonly lens: LintTarget;
  /** The board id the ops landed on, when a seat ran and wrote. */
  readonly boardId?: string;
  /** The validated board, when a seat resolved and drafted. */
  readonly board?: DraftBoard;
  readonly omissions: readonly Omission[];
  readonly blemishes: readonly Violation[];
  readonly immutability: readonly Violation[];
  /** An honest resolution failure — no harness for this seat (never a throw, never a block). */
  readonly failure?: string;
}

// ── The scheduler deps (all injected — the runtime is pure over them) ──

export interface LensPipelineDeps {
  /** The Claude harness port, or null when no `claude` resolved. */
  readonly claudePort: HarnessPort | null;
  /** The codex utility executor, or null when no `codex` resolved. */
  readonly codexExecutor: CodexExecutor | null;
  /** Council context override; availability defaults to the resolved ports. */
  readonly council?: CouncilResolveContext;
  /** The PR worktree the drafter sessions are rooted at (D1). */
  readonly repoRoot: string;
  /** The lens drafters' entire input, inlined into every prompt (B5). */
  readonly deltaPacket: DeltaPacket;
  /** The collation producer's hunk list — the coverage-assert universe (cluster 4). */
  readonly hunks: readonly LintHunk[];
  /** Per-lens lint context the caller assembles (files, patchsetId, scaffold globs…). */
  readonly lintContextFor: (lens: LintTarget) => LintContext;
  /** Read a prompt file's text (node fs seam; hermetic in tests). */
  readonly readPrompt: PromptReader;
  /** The sole board-op writer (B04). */
  readonly whiteboard: Pick<WhiteboardClient, "apply">;
  /** The board id one lens's ops land on (caller mints via `createRennetBoard`). */
  readonly boardIdFor: (lens: LintTarget) => string;
  /** The per-board arrival broadcast (B09 consumes; optional). */
  readonly onBoardArrival?: (event: BoardArrivalEvent) => void;
  /**
   * The durable home for a board's coverage/validation metadata (finding 3): the
   * `skippedHunks` and validation blemishes the whiteboard event log cannot carry.
   * Called after the board's ops are accepted and BEFORE its arrival is announced,
   * so a reconstructed result never announces a board whose coverage was lost. The
   * composition root supplies a real store; absent ⇒ metadata is result-only.
   */
  readonly persistBoardMeta?: (meta: BoardMeta) => void | Promise<void>;
  /** Prior generation's boards, for R58 delta stamps (cluster 4). */
  readonly previous?: ReadonlyMap<LintTarget, DraftBoard>;
  /**
   * The orchestrator's free-text authoring turn for the composition write-through
   * (C2). Present ⇒ `composeReviewDraft` runs after the lens boards freeze,
   * authoring the connective review prose on `REVIEW_DRAFT_VOICE_FILE`. Absent ⇒
   * composition authoring is skipped (the lens boards already ARE the reading
   * surface — C3).
   */
  readonly composeTurn?: (prompt: string) => Promise<string> | string;
  /**
   * The review-draft register lint context (read only when `composeTurn` is set).
   * Absent ⇒ the composition is linted against an EMPTY inventory, so every citation
   * in it is reported unresolvable. Production always supplies the round's real head
   * inventory (`RoundInput.reviewDraftLintCtx`, required); the fallback exists only
   * for a caller that drafts no composition.
   */
  readonly reviewDraftLintCtx?: RegisterLintContext;
  /** Curation feedback threaded from the prior generation into the authoring prompt (C2). */
  readonly curationFeedback?: string;
  readonly signal?: AbortSignal;
}

export interface LensPipelineResult {
  readonly boards: readonly LensBoardOutcome[];
  /**
   * Cross-lens every-hunk coverage (cluster 4), run ONCE over the frozen set.
   *
   * ABSENT means UNKNOWN, not clean. Coverage is computed from the drafted boards
   * themselves (which hunks each board teaches), and those boards live only in the run
   * that produced them: a result REBUILT from durable board metadata after a restart has
   * the ids and the blemishes but not the boards, so it cannot recompute the coverage
   * picture and says so rather than reporting an empty violation list — which would claim
   * a clean round it never verified.
   */
  readonly coverage?: readonly Violation[];
  /**
   * The round-report board, present only on a ROUND (a prior generation exists).
   * It drafts FIRST and is the lens drafters' input (D3/R58); it is NOT a lens,
   * so it is excluded from the coverage assert.
   */
  readonly report?: LensBoardOutcome;
  /** The authored composition (C2), present only when a `composeTurn` was supplied. */
  readonly composition?: ComposeResult;
}

// ── Seat resolution (council-routed, the B06 precedent) ──

/** Resolve one job to a concrete board `runTurn`, or an honest failure reason. */
function resolveBoardSeat(
  jobId: CouncilJobId,
  deps: LensPipelineDeps,
  council: CouncilResolveContext,
): ((prompt: string, attempt: number) => Promise<HarnessTurnResult>) | { failure: string } {
  const seat = councilSeatTurn(
    jobId,
    boardOutputSchema(),
    {
      claudePort: deps.claudePort,
      codexExecutor: deps.codexExecutor,
      repoRoot: deps.repoRoot,
      label: `board.${jobId}`,
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    },
    council,
  );
  return "failure" in seat ? { failure: seat.failure } : seat.runTurn;
}

/** The body of a turn, or an empty board on an honest turn failure. */
function bodyOr(result: HarnessTurnResult, fallback: unknown): unknown {
  return result.status === "emitted" ? result.body : fallback;
}

/**
 * Draft one lens: seed the seat, run the cluster-3 validation loop (post-process
 * wired to the real `board-post-process` editor pass), and return the validated
 * board — or an honest `failure` (finding 6). A failure is recorded, never a
 * throw and never a silent empty-success board, when: the INITIAL turn does not
 * emit a board (an empty fallback would ship as a schema-valid empty board), the
 * loop NEVER produces a parseable board across its attempts (`everParsed`), or a
 * seat call THROWS (a live-harness crash on the first turn or a retry). A thrown
 * RETRY degrades to keeping the current draft — the loop re-lints and escalates,
 * exactly the resolution-failure path — so one crashed retry never aborts a lens
 * that already has passing elements.
 */
async function draftOneLens(
  basePrompt: string,
  seatTurn: (prompt: string, attempt: number) => Promise<HarnessTurnResult>,
  postProcess: ((board: DraftBoard) => Promise<unknown>) | undefined,
  ctx: LintContext,
): Promise<Awaited<ReturnType<typeof validateDraft>> | { failure: string }> {
  const who = ctx.lens === "report" ? "round-report seat" : `${ctx.lens} lens`;
  try {
    const first = await seatTurn(basePrompt, 0);
    if (first.status !== "emitted") {
      return {
        failure: `${who}: the initial drafting turn did not emit a board (${first.status}).`,
      };
    }
    const validated = await validateDraft(first.body, ctx, {
      runTurn: async (req) => {
        try {
          const retry = await seatTurn(
            renderRetryPrompt(basePrompt, req.draft, req.pointers),
            req.attempt,
          );
          // An honest turn failure keeps the current draft — the loop re-lints, the
          // offending element escalates a rung, and an unfixable one becomes an
          // honest omission. Never a wipe (returning an empty board would drop passers).
          return bodyOr(retry, req.draft);
        } catch {
          // A THROWN retry (a live-harness crash mid-loop) degrades the same way —
          // keep the draft, let the loop escalate; one crashed retry is not fatal.
          return req.draft;
        }
      },
      ...(postProcess === undefined ? {} : { postProcess }),
    });
    if (!validated.everParsed) {
      return {
        failure: `${who}: no parseable board across ${validated.attempts} attempts — recorded as a failure, not an empty board.`,
      };
    }
    return validated;
  } catch (err) {
    // A throw on the FIRST turn (or anywhere outside the retry channel) degrades to
    // a recorded failure — never an uncaught throw that aborts the whole generation.
    return {
      failure: `${who}: the drafting seat threw — ${err instanceof Error ? err.message : String(err)}.`,
    };
  }
}

/**
 * Apply a validated board's ops and report whether the write was ACCEPTED (finding 2):
 * the board service validates references in order and rejects a bad batch, so the
 * pipeline must inspect `response.ok` — a rejected write is a lens failure, not a
 * silent success. On acceptance the board's coverage/validation metadata is durably
 * stored (finding 3) BEFORE the caller announces arrival, so a reconstructed result
 * never sees an announced board whose `skippedHunks` were lost.
 */
async function persistBoard(
  deps: LensPipelineDeps,
  lens: LintTarget,
  boardId: string,
  board: DraftBoard,
  validated: ValidatedLike,
  actor: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const result = await deps.whiteboard.apply(boardId, draftToOps(board), actor);
  if (!result.response.ok) {
    const code = (result.response as { code?: string }).code ?? "rejected";
    return {
      ok: false,
      reason: `${lens} board write rejected by the board service (${code}) — not announced as arrived.`,
    };
  }
  await deps.persistBoardMeta?.({
    lens,
    boardId,
    skippedHunks: boardSkippedHunks(board),
    blemishes: validated.blemishes,
    omissions: validated.omissions,
    immutability: validated.immutability,
  });
  return { ok: true };
}

/** Build the `board-post-process` editor seam, or `undefined` when no seat resolves. */
function buildPostProcess(
  deps: LensPipelineDeps,
  council: CouncilResolveContext,
  postProcessText: string,
): ((board: DraftBoard) => Promise<unknown>) | undefined {
  const seat = resolveBoardSeat("board-post-process", deps, council);
  if ("failure" in seat) return undefined; // no editor seat ⇒ identity (validate.ts default)
  return async (board: DraftBoard) => {
    const result = await seat(renderPostProcessPrompt(postProcessText, board), 0);
    // A failed editor turn is identity — the immutability gate has nothing to
    // catch, prose is simply un-polished. Never a block.
    return bodyOr(result, board);
  };
}

/**
 * Run the lens drafting pipeline for one generation. Seeds the five lens
 * drafters, validates + post-processes + writes each board, emits per-board
 * arrival on freeze, and runs the cross-lens coverage assert ONCE over the
 * frozen set. Honest degradation throughout: a lens whose seat cannot resolve is
 * recorded as a failure, never a throw.
 */
export async function runLensPipeline(deps: LensPipelineDeps): Promise<LensPipelineResult> {
  const council: CouncilResolveContext = deps.council ?? {
    availability: {
      installed: [
        ...(deps.claudePort ? (["claude-code"] as const) : []),
        ...(deps.codexExecutor ? (["codex"] as const) : []),
      ],
    },
  };

  const postProcessText = await deps.readPrompt(POST_PROCESS_FILE);
  const postProcess = buildPostProcess(deps, council, postProcessText);

  // R58/D3 — on a ROUND (a prior generation exists, so the packet carries a
  // successor account) the round-report drafts FIRST: it gates the regeneration
  // and is the lens drafters' input. Its validated board is threaded into every
  // lens prompt below. Not a lens — excluded from the coverage assert.
  const isRound = deps.deltaPacket.successorAccount !== undefined;
  const report = isRound ? await runRoundReport(deps, council, postProcess) : undefined;
  const reportBoard = report?.board;

  const outcomes: LensBoardOutcome[] = [];
  for (const lens of LENS_KINDS) {
    outcomes.push(await runLensBoard(lens, deps, council, postProcess, reportBoard));
  }

  // Cluster-4 coverage, ONCE over the frozen board set (the compositionGate seam
  // stays no-op per board — this is the cross-lens obligation). Runs BEFORE any lens
  // arrival is announced (finding 3): a board's write is already accepted and its
  // metadata durably stored inside `runLensBoard`; the announcement waits until
  // cross-lens coverage is known, so a reader never sees a lens announced "ready"
  // before the coverage picture that frames it.
  const boards = outcomes.map((o) => o.board).filter((b): b is DraftBoard => b !== undefined);
  const coverage = assertCoverage(boards, deps.hunks);

  // Announce each accepted lens board now that coverage is known (finding 2/3).
  for (const o of outcomes) {
    if (o.board !== undefined && o.boardId !== undefined) {
      deps.onBoardArrival?.({
        lens: o.lens,
        boardId: o.boardId,
        elementCount: o.board.elements.length,
        // C15 3.3: the carried signal rides the arrival so the live lane label is the
        // SAME `stampDeltas` fact the section markers render — not a re-derivation.
        carried: isCarriedForward(deps.previous?.get(o.lens), o.board),
      });
    }
  }

  // C2 — the authored composition write-through, when the orchestrator supplied a
  // free-text authoring turn. The lens boards ARE the reading surface (C3); this
  // adds only the connective review prose, not a sixth board.
  let composition: ComposeResult | undefined;
  if (deps.composeTurn !== undefined) {
    const boardsByLens = new Map<LintTarget, DraftBoard>();
    for (const o of outcomes) if (o.board !== undefined) boardsByLens.set(o.lens, o.board);
    composition = await composeReviewDraft({
      boards: boardsByLens,
      ...(deps.previous === undefined ? {} : { previous: deps.previous }),
      voicePromptText: await deps.readPrompt(REVIEW_DRAFT_VOICE_FILE),
      authorTurn: deps.composeTurn,
      lintCtx: deps.reviewDraftLintCtx ?? { files: new Map() },
      ...(deps.curationFeedback === undefined ? {} : { curationFeedback: deps.curationFeedback }),
    });
  }

  return {
    boards: outcomes,
    coverage,
    ...(report === undefined ? {} : { report }),
    ...(composition === undefined ? {} : { composition }),
  };
}

/**
 * The round-report drafter (D3, R58): resolves the `round-report` seat, drafts
 * with the report lint register (`ctx.lens === "report"` ⇒ `REPORT_RULES`, no
 * hunk-coverage obligation), funnels through the SAME post-process pass, writes
 * to the report board, and announces its arrival. Honest degradation: no seat ⇒
 * `undefined`, and the lens drafters simply proceed without a report.
 */
async function runRoundReport(
  deps: LensPipelineDeps,
  council: CouncilResolveContext,
  postProcess: ((board: DraftBoard) => Promise<unknown>) | undefined,
): Promise<LensBoardOutcome | undefined> {
  const seat = resolveBoardSeat("round-report", deps, council);
  if ("failure" in seat) return undefined;

  const promptText = await deps.readPrompt(ROUND_REPORT_FILE);
  const basePrompt = renderDrafterPrompt(promptText, deps.deltaPacket);
  const ctx = deps.lintContextFor("report");
  const validated = await draftOneLens(basePrompt, seat, postProcess, ctx);
  if ("failure" in validated) {
    return {
      lens: "report",
      omissions: [],
      blemishes: [],
      immutability: [],
      failure: validated.failure,
    };
  }
  const stamped = stampDeltas(deps.previous?.get("report"), validated.board);

  const boardId = deps.boardIdFor("report");
  const persisted = await persistBoard(deps, "report", boardId, stamped, validated, "seat:report");
  if (!persisted.ok) {
    return {
      lens: "report",
      omissions: validated.omissions,
      blemishes: validated.blemishes,
      immutability: validated.immutability,
      failure: persisted.reason,
    };
  }
  // The report is the reviewer's greeting (R58) — it announces its arrival inline,
  // ahead of the lens boards, once its write is accepted and its metadata is durable.
  deps.onBoardArrival?.({
    lens: "report",
    boardId,
    elementCount: stamped.elements.length,
    carried: isCarriedForward(deps.previous?.get("report"), stamped),
  });

  return {
    lens: "report",
    boardId,
    board: stamped,
    omissions: validated.omissions,
    blemishes: validated.blemishes,
    immutability: validated.immutability,
  };
}

/** Draft, validate, post-process, write, and announce one lens board. */
/** The shape the common tail needs — one seat's or the reconciled dual seat's. */
interface ValidatedLike {
  readonly board: DraftBoard;
  readonly omissions: readonly Omission[];
  readonly blemishes: readonly Violation[];
  readonly immutability: readonly Violation[];
}

/**
 * The Flagged dual seat (J1/J2, cluster 5.2): run `lens-draft-flagged` as TWO
 * independent seats — Claude and Codex, each forced to its own provider — and
 * reconcile their findings by location into per-finding cross-model concurrence.
 * Degrades to a SINGLE seat (honest single-seat concurrence) when only one
 * harness resolves. Returns a failure only when neither seat can run.
 */
async function runFlaggedDual(
  deps: LensPipelineDeps,
  postProcess: ((board: DraftBoard) => Promise<unknown>) | undefined,
  basePrompt: string,
  ctx: LintContext,
): Promise<ValidatedLike | { failure: string }> {
  const claudeSeat = deps.claudePort
    ? resolveBoardSeat("lens-draft-flagged", deps, { availability: { installed: ["claude-code"] } })
    : { failure: "no claude harness" };
  const codexSeat = deps.codexExecutor
    ? resolveBoardSeat("lens-draft-flagged", deps, { availability: { installed: ["codex"] } })
    : { failure: "no codex harness" };

  const haveClaude = typeof claudeSeat === "function";
  const haveCodex = typeof codexSeat === "function";
  if (!haveClaude && !haveCodex) {
    return { failure: "lens-draft-flagged resolved to no runnable seat" };
  }

  // Single-seat degrade — honest single-model concurrence.
  if (!haveClaude || !haveCodex) {
    const seat = haveClaude
      ? (claudeSeat as (p: string, a: number) => Promise<HarnessTurnResult>)
      : (codexSeat as (p: string, a: number) => Promise<HarnessTurnResult>);
    const label = haveClaude ? DEFAULT_SEAT_LABELS["claude-code"] : DEFAULT_SEAT_LABELS.codex;
    const single = await draftOneLens(basePrompt, seat, postProcess, ctx);
    if ("failure" in single) return { failure: single.failure };
    return { ...single, board: stampSingleSeatConcurrence(single.board, label) };
  }

  // Both seats run independently; reconcile their findings (Claude is seat A).
  const [a, b] = await Promise.all([
    draftOneLens(
      basePrompt,
      claudeSeat as (p: string, at: number) => Promise<HarnessTurnResult>,
      postProcess,
      ctx,
    ),
    draftOneLens(
      basePrompt,
      codexSeat as (p: string, at: number) => Promise<HarnessTurnResult>,
      postProcess,
      ctx,
    ),
  ]);
  const aOk = !("failure" in a);
  const bOk = !("failure" in b);
  // Neither seat produced a board ⇒ the flagged lens honestly failed.
  if (!aOk && !bOk) {
    return {
      failure: `both flagged seats failed — ${(a as { failure: string }).failure} | ${(b as { failure: string }).failure}`,
    };
  }
  // One seat failed ⇒ degrade to the survivor with honest single-model concurrence.
  if (!aOk || !bOk) {
    const ok = (aOk ? a : b) as ValidatedLike;
    const label = aOk ? DEFAULT_SEAT_LABELS["claude-code"] : DEFAULT_SEAT_LABELS.codex;
    return { ...ok, board: stampSingleSeatConcurrence(ok.board, label) };
  }
  const seatA = a as ValidatedLike;
  const seatB = b as ValidatedLike;
  const labels = { a: DEFAULT_SEAT_LABELS["claude-code"], b: DEFAULT_SEAT_LABELS.codex };
  const merged = reconcileFlaggedBoards(seatA.board, seatB.board, labels);
  // Wire-validate the merged board (finding 7): a reconciliation that produced a
  // structurally-invalid board surfaces as a labeled blemish, never ships silently.
  const wire = parseDraft(merged);
  const mergeBlemishes: Violation[] = wire.ok
    ? []
    : wire.issues.map((i) => ({
        ruleId: "schema-invalid",
        elementRef: `/${(i.path as (string | number)[]).join("/")}`,
        message: i.message,
      }));
  return {
    board: merged,
    omissions: [...seatA.omissions, ...seatB.omissions],
    blemishes: [...seatA.blemishes, ...seatB.blemishes, ...mergeBlemishes],
    immutability: [...seatA.immutability, ...seatB.immutability],
  };
}

async function runLensBoard(
  lens: LensKind,
  deps: LensPipelineDeps,
  council: CouncilResolveContext,
  postProcess: ((board: DraftBoard) => Promise<unknown>) | undefined,
  reportBoard?: DraftBoard,
): Promise<LensBoardOutcome> {
  const promptText = await deps.readPrompt(LENS_PROMPT_FILES[lens]);
  const basePrompt = renderDrafterPrompt(promptText, deps.deltaPacket, reportBoard);
  const ctx = deps.lintContextFor(lens);

  let validated: ValidatedLike;
  if (lens === "flagged") {
    // The flagged lens is the dual seat (Claude + Codex, cross-model concurrence).
    const dual = await runFlaggedDual(deps, postProcess, basePrompt, ctx);
    if ("failure" in dual) {
      return { lens, omissions: [], blemishes: [], immutability: [], failure: dual.failure };
    }
    validated = dual;
  } else {
    const jobId: CouncilJobId = lens === "noise" ? "lens-draft-noise" : "lens-draft";
    const seat = resolveBoardSeat(jobId, deps, council);
    if ("failure" in seat) {
      return { lens, omissions: [], blemishes: [], immutability: [], failure: seat.failure };
    }
    const drafted = await draftOneLens(basePrompt, seat, postProcess, ctx);
    if ("failure" in drafted) {
      return { lens, omissions: [], blemishes: [], immutability: [], failure: drafted.failure };
    }
    validated = drafted;
  }

  // R58 delta stamps against the prior generation's board (cluster 4).
  const stamped = stampDeltas(deps.previous?.get(lens), validated.board);

  // Write the board and INSPECT the response (finding 2): a rejected batch is a lens
  // failure, never announced as arrived. On acceptance the coverage/validation
  // metadata is durably stored (finding 3). Arrival is NOT emitted here — the pipeline
  // announces lens arrivals only after cross-lens coverage runs over the frozen set.
  const boardId = deps.boardIdFor(lens);
  const persisted = await persistBoard(deps, lens, boardId, stamped, validated, `lens:${lens}`);
  if (!persisted.ok) {
    return {
      lens,
      omissions: validated.omissions,
      blemishes: validated.blemishes,
      immutability: validated.immutability,
      failure: persisted.reason,
    };
  }

  return {
    lens,
    boardId,
    board: stamped,
    omissions: validated.omissions,
    blemishes: validated.blemishes,
    immutability: validated.immutability,
  };
}
