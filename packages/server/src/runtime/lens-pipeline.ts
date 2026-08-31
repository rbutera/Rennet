import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DesignArtifactSet, WhiteboardClient } from "@rennet/adapters";
import { councilSeatTurn, createCoverageTurn } from "@rennet/adapters";
import {
  assertCoverage,
  type CodexExecutor,
  type CoverageHunkInput,
  type CoverageRequirementInput,
  carriedElementIds,
  composeFindingRound,
  createInvocationBudget,
  DEFAULT_SEAT_LABELS,
  type DeltaPacket,
  type DesignTaskProgressSource,
  deriveDesignTaskProgress,
  elementReferenceFields,
  elementReferences,
  type FindingResolution,
  type HarnessPort,
  type HarnessTurnResult,
  isCarriedForward,
  isScaffoldPath,
  type LintContext,
  type LintHunk,
  type LintTarget,
  lintReviewDraft,
  NO_CONCERN_ANSWER,
  type Omission,
  parseDesignSourceObligations,
  type RegisterLintContext,
  reconcileFindings,
  runCoverageMapping,
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
  type BoardDocument,
  type ComposableAsk,
  type CouncilJobId,
  type CouncilResolveContext,
  type DraftBoard,
  DraftBoardSchema,
  type DraftElement,
  type FindingAccord,
  type FindingAgreement,
  type FindingDisposition,
  type FindingElement,
  generationIdForPatchset,
  LENS_KINDS,
  type LensAbsenceReason,
  type LensKind,
  parseDraft,
  resolveBoardDocument,
  SEVERITY_LEVELS,
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
const DesignNoMaterialSchema = z.object({
  absence: z.literal("no-material"),
  candidates: z.array(
    z.object({
      id: z.string().min(1),
      relevance: z.enum(["changed-artifact", "references-changed-path", "repository-candidate"]),
      reason: z.string().trim().min(1),
    }),
  ),
});
const DesignDraftOutputSchema = z.union([DraftBoardSchema, DesignNoMaterialSchema]);
let cachedDesignDraftSchema: unknown;
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

export function designDraftOutputSchema(): unknown {
  if (cachedDesignDraftSchema !== undefined) return cachedDesignDraftSchema;
  try {
    cachedDesignDraftSchema = z.toJSONSchema(DesignDraftOutputSchema, { io: "output" });
  } catch {
    cachedDesignDraftSchema = boardOutputSchema();
  }
  return cachedDesignDraftSchema;
}

// ── Draft → board ops (the host writes ops on the drafter's behalf, D2) ──

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
    for (const { targetId: refId } of elementReferences(el)) {
      if (!liveIds.has(refId)) continue;
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

/**
 * The agreement KIND, as the wire's `accord` — the fact {@link foldConcurrence}'s
 * tallies structurally cannot express.
 *
 * A concurring pair folds to `[{a,1,1},{b,1,1}]`. So does a CONFLICT: two seats that
 * both raised the finding at materially different severities, where NEITHER answer is
 * `NO_CONCERN_ANSWER` (`core/src/finding-reconcile.ts` — the conflict arm of
 * `reconcileFindings`). The two tally sets are byte-identical, so a client reading the
 * arithmetic alone renders a disagreement as agreement. This stamp is the difference.
 */
function accordOf(agreement: FindingAgreement): FindingAccord {
  if (agreement.kind === "concur") return "concur";
  return agreement.answers.some((ans) => ans.answer === NO_CONCERN_ANSWER) ? "split" : "conflict";
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

/** Describe a final Flagged finding set while keeping its authored title. */
function finalizedFlaggedDocument(
  authored: BoardDocument | undefined,
  elements: readonly DraftElement[],
): BoardDocument | undefined {
  if (authored === undefined) return undefined;

  const severityCounts = { high: 0, medium: 0, low: 0 };
  let findingCount = 0;
  for (const element of elements) {
    if (element.kind !== "finding") continue;
    findingCount += 1;
    severityCounts[element.data.severity] += 1;
  }

  const severityPicture = SEVERITY_LEVELS.filter((severity) => severityCounts[severity] > 0).map(
    (severity) => `${severityCounts[severity]} ${severity}`,
  );
  const introMarkdown =
    findingCount === 0
      ? "No findings require attention."
      : `${findingCount} ${findingCount === 1 ? "finding requires" : "findings require"} attention: ${severityPicture.join(", ")}.`;

  return { ...authored, introMarkdown, measure: "reading" };
}

/** The findings the served board can reach from its top-level section roots. */
function reachableFindingElements(elements: readonly DraftElement[]): DraftElement[] {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const nested = new Set<string>();
  for (const element of elements) {
    if (element.kind !== "section" && element.kind !== "order_step") continue;
    for (const child of element.data.children) nested.add(child);
  }

  const findings: DraftElement[] = [];
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const element = byId.get(id);
    if (element === undefined) return;
    if (element.kind === "finding") {
      findings.push(element);
      return;
    }
    if (element.kind !== "section" && element.kind !== "order_step") return;
    for (const child of element.data.children) visit(child);
  };

  for (const element of elements) {
    if (element.kind === "section" && !nested.has(element.id)) visit(element.id);
  }
  return findings;
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
      data: {
        ...(el.data as object),
        concurrence: foldConcurrence(r.agreement, labels),
        accord: accordOf(r.agreement),
      },
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

  const document = finalizedFlaggedDocument(boardA.document ?? boardBArg.document, elements);

  return {
    ...(boardA as object),
    ...(document === undefined ? {} : { document }),
    elements,
    skippedHunks: mergeSkips(boardA, boardB),
  } as DraftBoard;
}

/**
 * Stamp single-seat concurrence on every finding (the honest degrade — one harness only).
 *
 * No `accord`: one seat has no agreement to report. Stamping `concur` here would claim a
 * second opinion that never ran, and `split` would name a disagreement with nobody.
 */
export function stampSingleSeatConcurrence(board: DraftBoard, label: string): DraftBoard {
  const elements = board.elements.map((el) =>
    el.kind === "finding"
      ? ({
          ...el,
          data: { ...(el.data as object), concurrence: [{ model: label, agree: 1, total: 1 }] },
        } as DraftElement)
      : el,
  );
  const document = finalizedFlaggedDocument(board.document, elements);
  return {
    ...(board as object),
    ...(document === undefined ? {} : { document }),
    elements,
  } as DraftBoard;
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
  designArtifacts?: DesignArtifactSet,
  hostSchema: unknown = boardOutputSchema(),
  round?: RoundDraftContext,
): string {
  const context = JSON.stringify({
    deltaPacket: packet,
    hostSchema,
    // On rounds the round-report drafts FIRST and is the lens drafters' input (D3/R58).
    ...(reportBoard === undefined ? {} : { roundReport: reportBoard }),
    ...(designArtifacts === undefined ? {} : { designArtifacts }),
    ...(round === undefined
      ? {}
      : {
          round: {
            number: round.number,
            dispatchedAsks: round.dispatchedAsks,
            ...(round.worker === undefined ? {} : { worker: round.worker }),
          },
        }),
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
 * A board's document/validation/coverage metadata (finding 3). `draftToOps` serializes
 * only a board's ELEMENTS to the whiteboard event log; its document opening,
 * `skippedHunks`, and validation results are board-level, live only in memory, and the
 * frozen 13-kind vocabulary has no element to carry them. This is the durable home the
 * composition root supplies (a store keyed by `boardId`), persisted BEFORE a board's
 * arrival is announced so a reader never reconstructs an incomplete board.
 */
export interface BoardMeta {
  readonly lens: LintTarget;
  readonly boardId: string;
  /** Optional only for records reconstructed from before this contract; new writes always set it. */
  readonly document?: BoardDocument;
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
  /** Flagged-only reattachment/detachment facts for durable disposition migration. */
  readonly findingResolutions?: readonly FindingResolution[];
  /** An honest resolution failure — no harness for this seat (never a throw, never a block). */
  readonly failure?: string;
  /** A successful typed absence: the lens ran and honestly found nothing to render. */
  readonly absence?: LensAbsenceReason;
}

export interface DesignCoverageRequest {
  readonly patchsetId: string;
  readonly requirements: readonly CoverageRequirementInput[];
  readonly hunks: readonly CoverageHunkInput[];
}

export type DesignCoverageMapper = (request: DesignCoverageRequest) => Promise<{
  readonly status: "ok" | "failed";
  readonly edges: readonly {
    readonly capability: string;
    readonly requirement: string;
    readonly hunks: readonly string[];
    readonly tests: number;
  }[];
}>;

/** Build the real grounded coverage turn over one resolved Claude seat. */
export function createDesignCoverageMapper(
  port: HarnessPort,
  repoRoot: string,
): DesignCoverageMapper {
  const turn = createCoverageTurn(port, { cwd: repoRoot });
  return async (request) => {
    const result = await runCoverageMapping({
      ...request,
      runTurn: async (prompt) => {
        try {
          return await turn(prompt);
        } catch (error) {
          return {
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
          };
        }
      },
      budget: createInvocationBudget(2),
    });
    return { status: result.status, edges: result.edges };
  };
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
  /** Exact generation visit being drafted. Older direct callers fall back to the initial
   *  content-derived generation; the rounds runtime always supplies this. */
  readonly currentGeneration?: string;
  /** Trusted durable-ask identity for a returned round. */
  readonly round?: RoundDraftContext;
  /** The collation producer's hunk list — the coverage-assert universe (cluster 4). */
  readonly hunks: readonly LintHunk[];
  /** Per-lens lint context the caller assembles (files, patchsetId, scaffold globs…). */
  readonly lintContextFor: (lens: LintTarget) => LintContext;
  /** Undefined keeps the legacy drafter-owned discovery path; null is a successful no-spec result. */
  readonly designArtifacts?: DesignArtifactSet | null;
  /** Pinned discovery failed before drafting. Settles Design only; sibling lenses still run. */
  readonly designArtifactFailure?: string;
  /** Grounded requirement-to-hunk mapping. Absent means coverage was not computed. */
  readonly mapDesignCoverage?: DesignCoverageMapper;
  /** Read a prompt file's text (node fs seam; hermetic in tests). */
  readonly readPrompt: PromptReader;
  /** The sole board-op writer (B04). */
  readonly whiteboard: Pick<WhiteboardClient, "apply">;
  /** The board id one lens's ops land on (caller mints via `createRennetBoard`). */
  readonly boardIdFor: (lens: LintTarget) => string;
  /** The per-board arrival broadcast (B09 consumes; optional). */
  readonly onBoardArrival?: (event: BoardArrivalEvent) => void;
  /** A successful lens absence, emitted as soon as discovery settles it. */
  readonly onLensAbsence?: (lens: LensKind, reason: LensAbsenceReason) => void | Promise<void>;
  /**
   * The lens drafters are about to start. Fires exactly once per pipeline, immediately
   * before the first lens drafts — so AFTER the round report has settled, whichever way it
   * settled. This is the honest kickoff signal: the caller's lane block reads "queued" until
   * something says otherwise, and the report's ARRIVAL cannot be that something on a run
   * where the report was expected and then FAILED (no arrival is announced, and the failure
   * sweep only runs once the whole pipeline is over). The lenses run regardless — the report
   * gates the reveal, not the drafting — so the lanes must start regardless too.
   */
  readonly onLensDraftingStart?: () => void;
  /**
   * The durable home for a board's coverage/validation metadata (finding 3): the
   * `skippedHunks` and validation blemishes the whiteboard event log cannot carry.
   * Called after the board's ops are accepted and BEFORE its arrival is announced,
   * so a reconstructed result never announces a board whose coverage was lost. The
   * composition root supplies a real store; absent ⇒ metadata is result-only.
   */
  readonly persistBoardMeta?: (meta: BoardMeta) => void | Promise<void>;
  /** Read the reviewer-owned overlay at the exact Flagged composition boundary. */
  readonly readFindingDispositions?: () => Readonly<Record<string, FindingDisposition>>;
  /** Persist/migrate Flagged resolution state before its hidden board is written. */
  readonly persistFindingResolutions?: (
    currentGeneration: string,
    currentBoardId: string,
    resolutions: readonly FindingResolution[],
    findingDispositions: Readonly<Record<string, FindingDisposition>>,
  ) => void | Promise<void>;
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

export interface RoundDraftContext {
  readonly number: number;
  readonly previousGeneration: string;
  readonly previousFlaggedBoardId?: string;
  readonly dispatchedAsks: readonly ComposableAsk[];
  readonly findingDispositions: Readonly<Record<string, FindingDisposition>>;
  /** Checkpoint-measured evidence from this coding turn. Production supplies it after
   *  the turn returns, so the report verifies the worker's exact delta rather than the
   *  whole branch or the worker's account of itself. */
  readonly worker?: {
    readonly outcome: "completed";
    readonly diff: string;
    readonly changedPaths: readonly string[];
    readonly commitRange: { readonly from: string; readonly to: string };
  };
}

export interface LensPipelineResult {
  readonly boards: readonly LensBoardOutcome[];
  /** The Flagged board's reattachment/detachment facts, when this was a round. */
  readonly findingResolutions?: readonly FindingResolution[];
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

function pipelineGenerationId(
  deps: Pick<LensPipelineDeps, "currentGeneration" | "deltaPacket">,
): string {
  return deps.currentGeneration ?? generationIdForPatchset(deps.deltaPacket.patchset.id);
}

/**
 * Whether this run drafts a ROUND REPORT ahead of the lens boards — see the R58/D3 note
 * at the call site for why the two shapes differ.
 *
 * Exported because the report is also what promotes the live lens lanes' first drafter:
 * the arrival of the report calls `lanes.start()`. A run that drafts no report has to
 * start them at kickoff instead, and the caller can only know which it is by asking the
 * same question the pipeline asks. Copying the predicate over there would let the two
 * drift into a run that starts its lanes twice (the first lane reads "running" while the
 * report is still drafting) or never (the first lens reads "queued" for its whole run,
 * which is the bug this was extracted for).
 */
export function draftsRoundReport(
  deps: Pick<LensPipelineDeps, "currentGeneration" | "deltaPacket" | "round">,
): boolean {
  // R58/D3 — a landed dispatched round is explicit in its generation lineage. The
  // successor account is useful report material, but it is not the round marker: old
  // reviews can reconstruct exact durable asks without `review.dispositions`, so their
  // account may be absent even though the code moved. A same-generation round is the
  // honest no-code shape and drafts no report. Legacy callers without round context keep
  // the old successor-account signal.
  return deps.round === undefined
    ? deps.deltaPacket.successorAccount !== undefined
    : deps.round.previousGeneration !== pipelineGenerationId(deps);
}

// ── Seat resolution (council-routed, the B06 precedent) ──

/** Resolve one job to a concrete board `runTurn`, or an honest failure reason. */
function resolveBoardSeat(
  jobId: CouncilJobId,
  deps: LensPipelineDeps,
  council: CouncilResolveContext,
  outputSchema: unknown = boardOutputSchema(),
): ((prompt: string, attempt: number) => Promise<HarnessTurnResult>) | { failure: string } {
  const seat = councilSeatTurn(
    jobId,
    outputSchema,
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

class GroundedDesignAbsenceSignal extends Error {
  constructor() {
    super("The Design candidate set was dismissed with grounded no-material evidence.");
    this.name = "GroundedDesignAbsenceSignal";
  }
}

const EMPTY_LENS_ABSENCE: Partial<Record<LensKind, LensAbsenceReason>> = {
  decisions: "no-decisions",
  flagged: "no-findings",
  noise: "no-noise",
};

function requiredBoardRetryPrompt(basePrompt: string, lens: LintTarget): string {
  const name = lens === "report" ? "round report" : `${lens} lens`;
  return `${basePrompt}\n\nRETRY: The ${name} response validated but contained zero elements. This lane requires a visible reading result. Return a populated board grounded in the supplied change; do not return an empty elements array.`;
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
function draftOneLens(
  basePrompt: string,
  seatTurn: (prompt: string, attempt: number) => Promise<HarnessTurnResult>,
  postProcess: ((board: DraftBoard) => Promise<unknown>) | undefined,
  ctx: LintContext,
  transformOutput?: (output: unknown) => unknown,
): Promise<Awaited<ReturnType<typeof validateDraft>> | { readonly failure: string }>;
function draftOneLens(
  basePrompt: string,
  seatTurn: (prompt: string, attempt: number) => Promise<HarnessTurnResult>,
  postProcess: ((board: DraftBoard) => Promise<unknown>) | undefined,
  ctx: LintContext,
  transformOutput: (output: unknown) => unknown,
  initialAbsence: (output: unknown) => { readonly absence: "no-material" } | undefined,
): Promise<
  | Awaited<ReturnType<typeof validateDraft>>
  | { readonly failure: string }
  | { readonly absence: "no-material" }
>;
async function draftOneLens(
  basePrompt: string,
  seatTurn: (prompt: string, attempt: number) => Promise<HarnessTurnResult>,
  postProcess: ((board: DraftBoard) => Promise<unknown>) | undefined,
  ctx: LintContext,
  transformOutput: (output: unknown) => unknown = (output) => output,
  initialAbsence?: (output: unknown) => { readonly absence: "no-material" } | undefined,
): Promise<
  | Awaited<ReturnType<typeof validateDraft>>
  | { readonly failure: string }
  | { readonly absence: "no-material" }
> {
  const who = ctx.lens === "report" ? "round-report seat" : `${ctx.lens} lens`;
  try {
    const first = await seatTurn(basePrompt, 0);
    if (first.status !== "emitted") {
      return {
        failure: `${who}: the initial drafting turn did not emit a board (${first.status}: ${first.message}).`,
      };
    }
    const absence = initialAbsence?.(first.body);
    if (absence !== undefined) return absence;
    let retryAbsence: { readonly absence: "no-material" } | undefined;
    let validated: Awaited<ReturnType<typeof validateDraft>>;
    try {
      validated = await validateDraft(transformOutput(first.body), ctx, {
        runTurn: async (req) => {
          try {
            const retry = await seatTurn(
              renderRetryPrompt(basePrompt, req.draft, req.pointers),
              req.attempt,
            );
            if (retry.status === "emitted") {
              retryAbsence = initialAbsence?.(retry.body);
              if (retryAbsence !== undefined) throw new GroundedDesignAbsenceSignal();
            }
            // An honest turn failure keeps the current draft — the loop re-lints, the
            // offending element escalates a rung, and an unfixable one becomes an
            // honest omission. Never a wipe (returning an empty board would drop passers).
            return transformOutput(bodyOr(retry, req.draft));
          } catch (error) {
            if (error instanceof GroundedDesignAbsenceSignal) throw error;
            // A THROWN retry (a live-harness crash mid-loop) degrades the same way —
            // keep the draft, let the loop escalate; one crashed retry is not fatal.
            return req.draft;
          }
        },
        ...(postProcess === undefined
          ? {}
          : {
              postProcess: async (board: DraftBoard) => transformOutput(await postProcess(board)),
            }),
      });
    } catch (error) {
      if (error instanceof GroundedDesignAbsenceSignal && retryAbsence !== undefined) {
        return retryAbsence;
      }
      throw error;
    }
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
    document: resolveBoardDocument(lens, board.document),
    skippedHunks: boardSkippedHunks(board),
    blemishes: validated.blemishes,
    omissions: validated.omissions,
    immutability: validated.immutability,
  });
  return { ok: true };
}

const POST_PROCESS_NARRATIVE_KINDS: ReadonlySet<DraftElement["kind"]> = new Set([
  "prose",
  "callout",
  "annotation",
]);

/** Keep typed output and the document envelope stable across the prose-only editor pass. */
function preservePostProcessDocument(before: DraftBoard, edited: unknown): unknown {
  const parsed = DraftBoardSchema.safeParse(edited);
  if (!parsed.success) return edited;

  const beforeById = new Map(before.elements.map((element) => [element.id, element]));
  const preservedIds = new Set<string>();
  const preserveTree = (id: string): void => {
    if (preservedIds.has(id)) return;
    const element = beforeById.get(id);
    if (element === undefined) return;
    preservedIds.add(id);
    const children = (element.data as { children?: unknown }).children;
    if (!Array.isArray(children)) return;
    for (const child of children) if (typeof child === "string") preserveTree(child);
  };
  for (const element of before.elements) {
    if (element.kind === "requirement") {
      preserveTree(element.id);
      const scenarios = (element.data as { scenarios?: unknown }).scenarios;
      if (Array.isArray(scenarios)) {
        for (const scenario of scenarios) if (typeof scenario === "string") preserveTree(scenario);
      }
      continue;
    }
    if (
      element.kind === "section" &&
      ((element.data as { sources?: unknown }).sources !== undefined ||
        (element.data as { spec_delta?: unknown }).spec_delta !== undefined)
    ) {
      preserveTree(element.id);
    }
  }
  const isProtectedOriginal = (element: DraftElement): boolean =>
    preservedIds.has(element.id) || !POST_PROCESS_NARRATIVE_KINDS.has(element.kind);
  const preserveReferenceFields = (
    original: DraftElement,
    editedElement: DraftElement,
  ): DraftElement => {
    const data = { ...(editedElement.data as Record<string, unknown>) };
    const originalData = original.data as Record<string, unknown>;
    for (const field of elementReferenceFields(original)) {
      if (Object.hasOwn(originalData, field)) data[field] = originalData[field];
      else delete data[field];
    }
    return { ...editedElement, data } as DraftElement;
  };
  const editedById = new Map(parsed.data.elements.map((element) => [element.id, element]));
  const originalIds = new Set(before.elements.map((element) => element.id));
  const elements: DraftElement[] = [];
  for (const original of before.elements) {
    if (isProtectedOriginal(original)) {
      elements.push(original);
      continue;
    }
    const editedElement = editedById.get(original.id);
    if (editedElement === undefined) continue;
    elements.push(
      POST_PROCESS_NARRATIVE_KINDS.has(editedElement.kind)
        ? preserveReferenceFields(original, editedElement)
        : original,
    );
  }
  for (const element of parsed.data.elements) {
    if (originalIds.has(element.id) || !POST_PROCESS_NARRATIVE_KINDS.has(element.kind)) continue;
    elements.push(element);
  }

  if (before.document === undefined) {
    const withoutInventedDocument = { ...parsed.data, elements };
    delete withoutInventedDocument.document;
    return withoutInventedDocument;
  }

  const document =
    parsed.data.document === undefined
      ? { ...before.document }
      : {
          ...parsed.data.document,
          title: before.document.title,
          measure: before.document.measure,
        };
  if (before.document.sources === undefined) delete document.sources;
  else document.sources = before.document.sources;
  if (before.document.stats === undefined) delete document.stats;
  else document.stats = before.document.stats;

  return {
    ...parsed.data,
    document,
    elements,
  };
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
    return preservePostProcessDocument(board, bodyOr(result, board));
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

  // Whether a report drafts at all is `draftsRoundReport` (R58/D3, defined with the
  // predicate). It drafts FIRST and announces its own arrival, ahead of every lens.
  const report = draftsRoundReport(deps)
    ? await runRoundReport(deps, council, postProcess)
    : undefined;
  const reportBoard = report?.board;

  // The report has settled — arrived, failed, or was never expected — and the lens drafters
  // start now in all three cases. Saying so here, from the run itself, is what keeps the
  // caller's lane block honest on the path where the report was expected and FAILED: nothing
  // announces an arrival, so a caller that starts its lanes off the arrival alone shows
  // "queued" for the whole run while Design is the one lens working. This fires after the
  // report's arrival, never before, so the report's announce-first contract still holds.
  deps.onLensDraftingStart?.();

  const outcomes: LensBoardOutcome[] = [];
  for (const lens of LENS_KINDS) {
    const outcome = await runLensBoard(lens, deps, council, postProcess, reportBoard);
    outcomes.push(outcome);
    if (outcome.absence !== undefined) await deps.onLensAbsence?.(lens, outcome.absence);
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

  const findingResolutions = outcomes.find(
    (outcome) => outcome.lens === "flagged",
  )?.findingResolutions;

  return {
    boards: outcomes,
    coverage,
    ...(findingResolutions === undefined ? {} : { findingResolutions }),
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
  const basePrompt = renderDrafterPrompt(
    promptText,
    deps.deltaPacket,
    undefined,
    undefined,
    boardOutputSchema(),
    deps.round,
  );
  const ctx = deps.lintContextFor("report");
  let validated = await draftOneLens(basePrompt, seat, postProcess, ctx);
  if ("failure" in validated) {
    return {
      lens: "report",
      omissions: [],
      blemishes: [],
      immutability: [],
      failure: validated.failure,
    };
  }
  if (validated.board.elements.length === 0) {
    validated = await draftOneLens(
      requiredBoardRetryPrompt(basePrompt, "report"),
      seat,
      postProcess,
      ctx,
    );
    if ("failure" in validated) {
      return {
        lens: "report",
        omissions: [],
        blemishes: [],
        immutability: [],
        failure: validated.failure,
      };
    }
    if (validated.board.elements.length === 0) {
      return {
        lens: "report",
        omissions: validated.omissions,
        blemishes: validated.blemishes,
        immutability: validated.immutability,
        failure:
          "round-report seat: produced zero elements after one explicit retry; retry the generation to draft this required board.",
      };
    }
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

function discoveredArtifacts(set: DesignArtifactSet | null | undefined): readonly {
  readonly candidate: string;
  readonly format: DesignArtifactSet["candidates"][number]["format"];
  readonly path: string;
  readonly text: string;
  readonly role: string;
  readonly truncated: boolean;
  readonly sourceBytes: number;
}[] {
  if (set == null) return [];
  return set.candidates.flatMap((candidate) =>
    candidate.artifacts.map((artifact) => ({
      candidate: candidate.id,
      format: candidate.format,
      path: artifact.path,
      text: artifact.content,
      role: artifact.role,
      truncated: artifact.truncated,
      sourceBytes: artifact.sourceBytes,
    })),
  );
}

function designArtifactBundleIncomplete(set: DesignArtifactSet | null | undefined): boolean {
  if (set == null) return false;
  return (
    set.omittedCandidateCount > 0 ||
    set.omittedChangedPathCount > 0 ||
    set.candidates.some(
      (candidate) =>
        candidate.omittedArtifactCount > 0 ||
        candidate.nameTruncated ||
        candidate.artifacts.some((artifact) => artifact.truncated),
    )
  );
}

function designArtifactCandidates(set: DesignArtifactSet | null | undefined): readonly {
  readonly id: string;
  readonly name: string;
  readonly format: DesignArtifactSet["candidates"][number]["format"];
  readonly paths: readonly string[];
  readonly relevance: DesignArtifactSet["candidates"][number]["relevance"]["kind"];
}[] {
  if (set == null) return [];
  return set.candidates
    .map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      format: candidate.format,
      paths: [...new Set(candidate.artifacts.map((artifact) => artifact.path))],
      relevance: candidate.relevance.kind,
    }))
    .filter((candidate) => candidate.paths.length > 0);
}

type DiscoveredDesignArtifact = ReturnType<typeof discoveredArtifacts>[number];

interface TaskProjectionSource {
  readonly artifact: DiscoveredDesignArtifact;
  readonly progress: DesignTaskProgressSource;
}

function designSourceKey(candidate: string, path: string): string {
  return `${candidate}\u0000${path}`;
}

function sourceCandidate(
  source: { readonly candidate?: unknown },
  artifacts: DesignArtifactSet,
): string | undefined {
  if (typeof source.candidate === "string") return source.candidate;
  return artifacts.candidates.length === 1 ? artifacts.candidates[0]?.id : undefined;
}

function selectedTaskProjectionSources(
  board: DraftBoard,
  artifacts: DesignArtifactSet,
): readonly TaskProjectionSource[] {
  const selectedArtifacts = selectedProjectionArtifacts(board, artifacts);

  const progress = deriveDesignTaskProgress(
    selectedArtifacts.map((artifact) => ({
      candidate: artifact.candidate,
      format: artifact.format,
      role: artifact.role,
      path: artifact.path,
      text: artifact.text,
    })),
  );
  return progress.sources.flatMap((sourceProgress) => {
    const artifact = selectedArtifacts.find(
      (candidate) =>
        candidate.candidate === sourceProgress.source.candidate &&
        candidate.path === sourceProgress.source.path,
    );
    return artifact === undefined ? [] : [{ artifact, progress: sourceProgress }];
  });
}

function selectedProjectionArtifacts(
  board: DraftBoard,
  artifacts: DesignArtifactSet,
): readonly DiscoveredDesignArtifact[] {
  const selected = new Set(
    (board.document?.sources ?? []).flatMap((source) => {
      const candidate = sourceCandidate(source, artifacts);
      return candidate === undefined ? [] : [designSourceKey(candidate, source.path)];
    }),
  );
  const discovered = discoveredArtifacts(artifacts);
  return discovered.filter((artifact) =>
    selected.has(designSourceKey(artifact.candidate, artifact.path)),
  );
}

function normalizedTaskText(value: unknown): string | undefined {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : undefined;
}

const HOST_OWNED_DESIGN_FIELDS = [
  "task_progress",
  "scenario_clauses",
  "requirement_refs",
  "acceptance_criteria",
  "task_manifest",
  "glossary_term",
  "source_cells",
  "status",
] as const;

function stripDesignHostClaims(board: DraftBoard): DraftBoard {
  return {
    ...board,
    elements: board.elements.map((element) => {
      const data = { ...(element.data as Record<string, unknown>) };
      for (const field of HOST_OWNED_DESIGN_FIELDS) delete data[field];
      return { ...element, data } as DraftElement;
    }),
  };
}

function taskStatDocument(
  document: DraftBoard["document"],
  done: number,
  total: number,
): DraftBoard["document"] {
  if (document === undefined) return document;
  const stats = document.stats ?? [];
  const taskIndex = stats.findIndex((stat) => stat.label.toLowerCase() === "tasks");
  const withoutTasks = stats.filter((stat) => stat.label.toLowerCase() !== "tasks");
  if (total === 0) {
    const withoutStats = { ...document };
    delete withoutStats.stats;
    return withoutTasks.length === 0 ? withoutStats : { ...withoutStats, stats: withoutTasks };
  }
  const taskStat = { label: "Tasks", value: `${done}/${total}` };
  const next = [...withoutTasks];
  next.splice(taskIndex < 0 ? next.length : Math.min(taskIndex, next.length), 0, taskStat);
  return { ...document, stats: next };
}

function sourceLinksArtifact(
  element: DraftElement,
  artifact: DiscoveredDesignArtifact,
  artifacts: DesignArtifactSet,
): boolean {
  if (element.kind !== "section") return false;
  const sources = (element.data as { sources?: unknown }).sources;
  if (!Array.isArray(sources)) return false;
  return sources.some((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const source = value as { path?: unknown; candidate?: unknown };
    return (
      source.path === artifact.path && sourceCandidate(source, artifacts) === artifact.candidate
    );
  });
}

export function projectDesignTaskProgress(
  input: DraftBoard,
  artifacts: DesignArtifactSet,
): DraftBoard {
  const board = stripDesignHostClaims(input);
  const selectedArtifacts = selectedProjectionArtifacts(board, artifacts);
  const sources = selectedTaskProjectionSources(board, artifacts);
  const byId = new Map(board.elements.map((element) => [element.id, element]));
  const parentByChild = new Map<string, string>();
  for (const element of board.elements) {
    if (element.kind !== "section") continue;
    for (const child of element.data.children) {
      if (!parentByChild.has(child)) parentByChild.set(child, element.id);
    }
  }
  const topologyDescendants = (roots: readonly DraftElement[]): DraftElement[] => {
    const ordered: DraftElement[] = [];
    const seen = new Set<string>();
    const visit = (id: string): void => {
      if (seen.has(id)) return;
      seen.add(id);
      const element = byId.get(id);
      if (element === undefined) return;
      ordered.push(element);
      if (element.kind !== "section") return;
      for (const child of element.data.children) visit(child);
    };
    for (const root of roots) {
      if (root.kind !== "section") continue;
      for (const child of root.data.children) visit(child);
    }
    return ordered;
  };

  const taskProgress = new Map<string, Record<string, unknown>>();
  const sourceMetadata = new Map<string, Record<string, unknown>>();
  const addSourceMetadata = (id: string, metadata: Record<string, unknown>): void => {
    sourceMetadata.set(id, { ...sourceMetadata.get(id), ...metadata });
  };
  const scenarioClauses = new Map<
    string,
    { readonly condition: string; readonly response: string }
  >();
  for (const requirement of board.elements) {
    if (requirement.kind !== "requirement") continue;
    const data = requirement.data as {
      shall?: unknown;
      scenarios?: unknown;
      source?: { path?: unknown; candidate?: unknown; line?: unknown };
    };
    if (typeof data.shall !== "string") continue;
    const sourcePath = data.source?.path;
    const candidate = sourceCandidate(data.source ?? {}, artifacts);
    if (typeof sourcePath !== "string" || candidate === undefined) continue;
    const artifact = selectedArtifacts.find(
      (entry) => entry.candidate === candidate && entry.path === sourcePath,
    );
    if (artifact === undefined) continue;
    const obligations = parseDesignSourceObligations({
      format: artifact.format,
      role: artifact.role,
      path: artifact.path,
      text: artifact.text,
    });
    const sourceRequirement = obligations.find(
      (obligation) =>
        obligation.kind === "requirement" &&
        normalizedTaskText(obligation.text) === normalizedTaskText(data.shall) &&
        (typeof data.source?.line !== "number" || obligation.line === data.source.line),
    );
    if (sourceRequirement?.kind !== "requirement") continue;
    if (sourceRequirement.status !== undefined) {
      addSourceMetadata(requirement.id, { status: sourceRequirement.status });
    }
    if (!Array.isArray(data.scenarios)) continue;
    const sourceScenarios = obligations.filter(
      (obligation) =>
        obligation.kind === "scenario" && obligation.parentKey === sourceRequirement.key,
    );
    for (const scenarioId of data.scenarios) {
      if (typeof scenarioId !== "string") continue;
      const scenario = byId.get(scenarioId);
      if (scenario?.kind !== "prose") continue;
      const sourceScenario = sourceScenarios.find(
        (obligation) =>
          normalizedTaskText(obligation.text) === normalizedTaskText(scenario.data.markdown),
      );
      if (sourceScenario?.kind !== "scenario" || sourceScenario.clauses === undefined) continue;
      scenarioClauses.set(scenarioId, sourceScenario.clauses);
    }
  }

  for (const renderedDecision of board.elements) {
    if (renderedDecision.kind !== "decision") continue;
    const data = renderedDecision.data as {
      statement?: unknown;
      source?: { path?: unknown; candidate?: unknown; line?: unknown };
    };
    if (typeof data.statement !== "string") continue;
    const sourcePath = data.source?.path;
    const candidate = sourceCandidate(data.source ?? {}, artifacts);
    if (typeof sourcePath !== "string" || candidate === undefined) continue;
    const artifact = selectedArtifacts.find(
      (entry) => entry.candidate === candidate && entry.path === sourcePath,
    );
    if (artifact === undefined) continue;
    const sourceDecision = parseDesignSourceObligations({
      format: artifact.format,
      role: artifact.role,
      path: artifact.path,
      text: artifact.text,
    }).find(
      (obligation) =>
        obligation.kind === "decision" &&
        normalizedTaskText(obligation.text) === normalizedTaskText(data.statement) &&
        (typeof data.source?.line !== "number" || obligation.line === data.source.line),
    );
    if (sourceDecision?.kind !== "decision" || sourceDecision.sourceCells === undefined) continue;
    addSourceMetadata(renderedDecision.id, { source_cells: sourceDecision.sourceCells });
  }

  for (const artifact of selectedArtifacts) {
    const roots = board.elements.filter(
      (element) =>
        !parentByChild.has(element.id) && sourceLinksArtifact(element, artifact, artifacts),
    );
    const glossary = parseDesignSourceObligations({
      format: artifact.format,
      role: artifact.role,
      path: artifact.path,
      text: artifact.text,
    }).filter((obligation) => obligation.kind === "glossary-term");
    const prose = topologyDescendants(roots).filter((element) => element.kind === "prose");
    const used = new Set<string>();
    for (const obligation of glossary) {
      const match = prose.find(
        (element) =>
          !used.has(element.id) &&
          normalizedTaskText(element.data.markdown) === normalizedTaskText(obligation.text),
      );
      if (match === undefined) continue;
      used.add(match.id);
      addSourceMetadata(match.id, {
        glossary_term: {
          term: obligation.term,
          definition: obligation.definition,
          avoid: obligation.avoid,
        },
      });
    }
  }
  let taskDone = 0;
  let taskTotal = 0;

  for (const source of sources) {
    const sourceCount = { done: source.progress.done, total: source.progress.total };
    const roots = board.elements.filter(
      (element) =>
        !parentByChild.has(element.id) && sourceLinksArtifact(element, source.artifact, artifacts),
    );
    const rootIds = new Set(roots.map(({ id }) => id));
    const prose = topologyDescendants(roots).filter((element) => element.kind === "prose");
    const used = new Set<string>();
    const renderedGroups = new Map<
      string,
      {
        readonly rootId: string;
        readonly sectionId: string;
        readonly tasks: DesignTaskProgressSource["tasks"];
      }
    >();

    for (const obligation of source.progress.tasks) {
      const match = prose.find(
        (element) =>
          !used.has(element.id) && normalizedTaskText(element.data.markdown) === obligation.text,
      );
      if (match === undefined) continue;
      used.add(match.id);
      if (obligation.requirementRefs !== undefined) {
        addSourceMetadata(match.id, { requirement_refs: obligation.requirementRefs });
      }
      if (obligation.acceptanceCriteria !== undefined) {
        addSourceMetadata(match.id, { acceptance_criteria: obligation.acceptanceCriteria });
      }

      let parent = parentByChild.get(match.id);
      let nearestSection: string | undefined;
      let rootId: string | undefined;
      const visited = new Set<string>();
      while (parent !== undefined && !visited.has(parent)) {
        visited.add(parent);
        if (byId.get(parent)?.kind === "section") {
          nearestSection ??= parent;
          if (rootIds.has(parent)) {
            rootId = parent;
            break;
          }
        }
        parent = parentByChild.get(parent);
      }
      if (rootId === undefined || nearestSection === undefined) continue;
      const previous = renderedGroups.get(obligation.parentKey);
      renderedGroups.set(obligation.parentKey, {
        rootId,
        sectionId: previous?.sectionId ?? nearestSection,
        tasks: [...(previous?.tasks ?? []), obligation],
      });
    }

    const groupsByRoot = new Map<string, typeof renderedGroups>();
    for (const [parentKey, group] of renderedGroups) {
      const groups = groupsByRoot.get(group.rootId) ?? new Map();
      groups.set(parentKey, group);
      groupsByRoot.set(group.rootId, groups);
    }
    for (const root of roots) {
      const groups = groupsByRoot.get(root.id) ?? new Map();
      const grouped = [...groups.values()].some((group) => group.sectionId !== root.id);
      taskProgress.set(root.id, {
        kind: "source",
        format: source.artifact.format,
        role: source.artifact.role,
        layout: grouped ? "grouped" : "ungrouped",
        ...(grouped ? {} : sourceCount),
      });
      for (const group of groups.values()) {
        const manifest = group.tasks.find(
          (task: DesignTaskProgressSource["tasks"][number]) => task.manifest !== undefined,
        )?.manifest;
        if (manifest !== undefined) {
          addSourceMetadata(group.sectionId, { task_manifest: manifest });
        }
      }
      if (!grouped) continue;
      for (const [parentKey, group] of groups) {
        if (group.sectionId === root.id) continue;
        if (source.progress.format !== "superpowers" || source.artifact.role !== "plan") {
          taskProgress.set(group.sectionId, { kind: "group", state: "static" });
          continue;
        }
        const complete =
          source.progress.groups.find((candidate) => candidate.parentKey === parentKey)?.complete ??
          false;
        taskProgress.set(group.sectionId, {
          kind: "group",
          state: complete ? "complete" : "incomplete",
        });
      }
    }

    taskTotal += sourceCount.total;
    taskDone += sourceCount.done;
  }

  return {
    ...board,
    document: taskStatDocument(board.document, taskDone, taskTotal),
    elements: board.elements.map((element) => {
      const progress = taskProgress.get(element.id);
      const clauses = scenarioClauses.get(element.id);
      const metadata = sourceMetadata.get(element.id);
      if (progress === undefined && clauses === undefined && metadata === undefined) return element;
      return {
        ...element,
        data: {
          ...(element.data as Record<string, unknown>),
          ...metadata,
          ...(progress === undefined ? {} : { task_progress: progress }),
          ...(clauses === undefined ? {} : { scenario_clauses: clauses }),
        },
      } as unknown as DraftElement;
    }),
  };
}

function groundedDesignAbsence(
  output: unknown,
  set: DesignArtifactSet,
): { readonly absence: "no-material" } | undefined {
  if (designArtifactBundleIncomplete(set)) return undefined;
  if (DraftBoardSchema.safeParse(output).success) return undefined;
  const parsed = DesignNoMaterialSchema.safeParse(output);
  if (!parsed.success || parsed.data.candidates.length !== set.candidates.length) return undefined;
  const byId = new Map(parsed.data.candidates.map((candidate) => [candidate.id, candidate]));
  if (byId.size !== set.candidates.length) return undefined;
  for (const candidate of set.candidates) {
    const dismissed = byId.get(candidate.id);
    if (dismissed?.relevance !== candidate.relevance.kind) return undefined;
  }
  return { absence: "no-material" };
}

function requirementInputs(board: DraftBoard): CoverageRequirementInput[] {
  const byId = new Map(board.elements.map((element) => [element.id, element]));
  return board.elements.flatMap((element) => {
    if (element.kind !== "requirement") return [];
    const data = element.data as Record<string, unknown>;
    const shall = typeof data.shall === "string" ? data.shall : "";
    const name = typeof data.name === "string" && data.name.length > 0 ? data.name : element.id;
    const source =
      typeof data.source === "object" && data.source !== null
        ? (data.source as { path?: unknown }).path
        : undefined;
    const capability =
      typeof data.capability === "string" && data.capability.length > 0
        ? data.capability
        : typeof source === "string" && source.length > 0
          ? source
          : "design";
    const scenarioIds = Array.isArray(data.scenarios)
      ? data.scenarios.filter((id): id is string => typeof id === "string")
      : [];
    const scenarios = scenarioIds.flatMap((id) => {
      const scenario = byId.get(id);
      if (scenario?.kind !== "prose") return [];
      const markdown = (scenario.data as { markdown?: unknown }).markdown;
      return typeof markdown === "string" && markdown.length > 0 ? [markdown] : [];
    });
    return [{ capability, name, statement: shall, scenarios }];
  });
}

function offeredCoverageHunks(deps: LensPipelineDeps): {
  readonly inputs: CoverageHunkInput[];
  readonly ids: ReadonlySet<string>;
} {
  const artifactPaths = new Set(discoveredArtifacts(deps.designArtifacts).map(({ path }) => path));
  const inputs = (deps.deltaPacket.hunks?.hunks ?? [])
    .filter((hunk) => !artifactPaths.has(hunk.path) && !isScaffoldPath(hunk.path))
    .map((hunk) => ({
      id: hunk.id,
      filePath: hunk.path,
      addedLines: hunk.body
        .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
        .map((line) => line.slice(1)),
      deletedLines: hunk.body
        .filter((line) => line.startsWith("-") && !line.startsWith("---"))
        .map((line) => line.slice(1)),
    }));
  return { inputs, ids: new Set(inputs.map((hunk) => hunk.id)) };
}

function clearDraftedCoverage(board: DraftBoard): DraftBoard {
  return stripDraftedDesignCoverage(board) as DraftBoard;
}

function ensureDesignScaffoldSkips(board: DraftBoard, deps: LensPipelineDeps): DraftBoard {
  const existing = boardSkippedHunks(board);
  const known = new Set(existing.map(({ hunk }) => hunk));
  const scaffoldSkips = (deps.deltaPacket.hunks?.hunks ?? []).flatMap((hunk) => {
    if (!isScaffoldPath(hunk.path) || known.has(hunk.id)) return [];
    known.add(hunk.id);
    return [
      {
        hunk: hunk.id,
        reason: `${hunk.path} is a generated scaffold stamp owned by the Noise lens.`,
      },
    ];
  });
  if (scaffoldSkips.length === 0) return board;
  return { ...board, skippedHunks: [...existing, ...scaffoldSkips] };
}

function containsString(value: unknown, target: string): boolean {
  if (value === target) return true;
  if (Array.isArray(value)) return value.some((item) => containsString(item, target));
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value as Record<string, unknown>).some((item) =>
    containsString(item, target),
  );
}

/**
 * Coverage and related implementation paths are host-owned evidence. Remove any
 * drafter-authored mapping while the value is still unknown input, before
 * schema/lint and again after the editor pass. A code ref used only by an invented
 * trace goes with it, so it cannot teach a hunk.
 */
export function stripDraftedDesignCoverage(output: unknown): unknown {
  if (typeof output !== "object" || output === null || Array.isArray(output)) return output;
  const record = output as Record<string, unknown>;
  if (!Array.isArray(record.elements)) return output;

  const tracedIds = new Set<string>();
  const elements = record.elements.map((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      return candidate;
    }
    const element = candidate as Record<string, unknown>;
    if (
      element.kind !== "requirement" ||
      typeof element.data !== "object" ||
      element.data === null ||
      Array.isArray(element.data)
    ) {
      return candidate;
    }
    const data = { ...(element.data as Record<string, unknown>) };
    if (Array.isArray(data.trace)) {
      for (const id of data.trace) if (typeof id === "string") tracedIds.add(id);
    }
    delete data.coverage;
    delete data.trace;
    delete data.tests;
    delete data.related_files;
    return { ...element, data };
  });

  const withoutCoverageOnlyRefs = elements.filter((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      return true;
    }
    const element = candidate as Record<string, unknown>;
    if (element.kind !== "code_ref" || typeof element.id !== "string") return true;
    if (!tracedIds.has(element.id)) return true;
    return elements.some(
      (other) =>
        other !== candidate &&
        typeof other === "object" &&
        other !== null &&
        containsString((other as Record<string, unknown>).data, element.id as string),
    );
  });

  return { ...record, elements: withoutCoverageOnlyRefs };
}

function codeRefForCoverageHunk(
  hunkId: string,
  id: string,
  patchsetId: string,
  hunks: readonly LintHunk[],
): DraftElement | undefined {
  const hunk = hunks.find((candidate) => candidate.id === hunkId);
  if (hunk === undefined) return undefined;
  const head = hunk.newLines > 0;
  const start = head ? hunk.newStart : hunk.oldStart;
  const lines = head ? hunk.newLines : hunk.oldLines;
  if (start === undefined || lines === undefined || lines <= 0) return undefined;
  return {
    id,
    kind: "code_ref",
    data: {
      author: { kind: "orchestrator", id: "coverage-mapper" },
      patchset_id: patchsetId,
      path: head ? hunk.path : (hunk.previousPath ?? hunk.path),
      side: head ? "head" : "base",
      start_line: start,
      end_line: start + lines - 1,
    },
  } as DraftElement;
}

async function groundDesignCoverage(
  board: DraftBoard,
  deps: LensPipelineDeps,
): Promise<DraftBoard> {
  const cleared = ensureDesignScaffoldSkips(clearDraftedCoverage(board), deps);
  const requirements = requirementInputs(cleared);
  const offered = offeredCoverageHunks(deps);
  if (
    requirements.length === 0 ||
    offered.inputs.length === 0 ||
    deps.mapDesignCoverage === undefined
  ) {
    return cleared;
  }

  let mapped: Awaited<ReturnType<DesignCoverageMapper>>;
  try {
    mapped = await deps.mapDesignCoverage({
      patchsetId: deps.deltaPacket.patchset.id,
      requirements,
      hunks: offered.inputs,
    });
  } catch {
    return cleared;
  }
  if (mapped.status !== "ok") return cleared;

  const edgeByKey = new Map(
    mapped.edges.map((edge) => [`${edge.capability}\u0000${edge.requirement}`, edge] as const),
  );
  const ids = new Set(cleared.elements.map((element) => element.id));
  const refsByHunk = new Map<string, string>();
  const pathByRef = new Map<string, string>();
  const addedRefs: DraftElement[] = [];
  const refForHunk = (hunkId: string): string | undefined => {
    const known = refsByHunk.get(hunkId);
    if (known !== undefined) return known;
    if (!offered.ids.has(hunkId)) return undefined;
    let id = `coverage-hunk-${hunkId}`;
    let suffix = 2;
    while (ids.has(id)) {
      id = `coverage-hunk-${hunkId}-${suffix}`;
      suffix += 1;
    }
    const ref = codeRefForCoverageHunk(hunkId, id, deps.deltaPacket.patchset.id, deps.hunks);
    if (ref === undefined) return undefined;
    ids.add(id);
    refsByHunk.set(hunkId, id);
    const path = (ref.data as { path?: unknown }).path;
    if (typeof path === "string") pathByRef.set(id, path);
    addedRefs.push(ref);
    return id;
  };

  const elements = cleared.elements.map((element) => {
    if (element.kind !== "requirement") return element;
    const data = element.data as Record<string, unknown>;
    const name = typeof data.name === "string" && data.name.length > 0 ? data.name : element.id;
    const source =
      typeof data.source === "object" && data.source !== null
        ? (data.source as { path?: unknown }).path
        : undefined;
    const capability =
      typeof data.capability === "string" && data.capability.length > 0
        ? data.capability
        : typeof source === "string" && source.length > 0
          ? source
          : "design";
    const edge = edgeByKey.get(`${capability}\u0000${name}`);
    if (edge === undefined) return element;
    const trace = edge.hunks.flatMap((anchor) => {
      const prefix = "rennet:hunk/";
      const hunkId = anchor.startsWith(prefix) ? anchor.slice(prefix.length) : "";
      const ref = hunkId.length > 0 ? refForHunk(hunkId) : undefined;
      return ref === undefined ? [] : [ref];
    });
    const coverage = trace.length === 0 ? "gap" : edge.tests > 0 ? "met" : "partial";
    const relatedFiles = [
      ...new Set(
        trace.flatMap((refId) => {
          const path = pathByRef.get(refId);
          return path === undefined ? [] : [path];
        }),
      ),
    ];
    const grounded: Record<string, unknown> = { ...data, coverage, trace, tests: edge.tests };
    if (relatedFiles.length > 0) grounded.related_files = relatedFiles;
    return {
      ...element,
      data: grounded,
    } as DraftElement;
  });
  const groundedHunks = new Set(refsByHunk.keys());
  const skippedHunks = boardSkippedHunks(cleared).filter(({ hunk }) => !groundedHunks.has(hunk));
  return {
    ...cleared,
    elements: [...elements, ...addedRefs],
    ...("skippedHunks" in cleared ? { skippedHunks } : {}),
  };
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
  if (lens === "design" && deps.designArtifactFailure !== undefined) {
    return {
      lens,
      omissions: [],
      blemishes: [],
      immutability: [],
      failure: deps.designArtifactFailure,
    };
  }
  if (lens === "design" && deps.designArtifacts === null) {
    return {
      lens,
      omissions: [],
      blemishes: [],
      immutability: [],
      absence: "no-material",
    };
  }
  const promptText = await deps.readPrompt(LENS_PROMPT_FILES[lens]);
  const semanticDesignAbsence =
    lens === "design" && deps.designArtifacts !== undefined && deps.designArtifacts !== null;
  const basePrompt = renderDrafterPrompt(
    promptText,
    deps.deltaPacket,
    reportBoard,
    lens === "design" ? (deps.designArtifacts ?? undefined) : undefined,
    semanticDesignAbsence ? designDraftOutputSchema() : boardOutputSchema(),
    deps.round,
  );
  const baseCtx = deps.lintContextFor(lens);
  const artifacts = lens === "design" ? discoveredArtifacts(deps.designArtifacts) : [];
  const artifactCandidates =
    lens === "design" ? designArtifactCandidates(deps.designArtifacts) : [];
  const ctx: LintContext =
    artifacts.length > 0
      ? {
          ...baseCtx,
          artifacts,
          ...(artifactCandidates.length === 0 ? {} : { artifactCandidates }),
          ...(designArtifactBundleIncomplete(deps.designArtifacts)
            ? { artifactBundleIncomplete: true }
            : {}),
        }
      : baseCtx;
  const transformDesignOutput = (output: unknown): unknown => {
    const withoutCoverage = stripDraftedDesignCoverage(output);
    if (deps.designArtifacts === undefined || deps.designArtifacts === null) {
      return withoutCoverage;
    }
    const parsed = DraftBoardSchema.safeParse(withoutCoverage);
    return parsed.success
      ? projectDesignTaskProgress(parsed.data, deps.designArtifacts)
      : withoutCoverage;
  };

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
    const seat = resolveBoardSeat(
      jobId,
      deps,
      council,
      semanticDesignAbsence ? designDraftOutputSchema() : boardOutputSchema(),
    );
    if ("failure" in seat) {
      return { lens, omissions: [], blemishes: [], immutability: [], failure: seat.failure };
    }
    let drafted =
      semanticDesignAbsence && deps.designArtifacts !== undefined && deps.designArtifacts !== null
        ? await draftOneLens(basePrompt, seat, postProcess, ctx, transformDesignOutput, (output) =>
            groundedDesignAbsence(output, deps.designArtifacts as DesignArtifactSet),
          )
        : await draftOneLens(
            basePrompt,
            seat,
            postProcess,
            ctx,
            lens === "design" ? transformDesignOutput : undefined,
          );
    if (
      !("failure" in drafted) &&
      !("absence" in drafted) &&
      drafted.board.elements.length === 0 &&
      (lens === "design" || lens === "sequence")
    ) {
      const retryPrompt = requiredBoardRetryPrompt(basePrompt, lens);
      drafted =
        semanticDesignAbsence && deps.designArtifacts !== undefined && deps.designArtifacts !== null
          ? await draftOneLens(
              retryPrompt,
              seat,
              postProcess,
              ctx,
              transformDesignOutput,
              (output) => groundedDesignAbsence(output, deps.designArtifacts as DesignArtifactSet),
            )
          : await draftOneLens(
              retryPrompt,
              seat,
              postProcess,
              ctx,
              lens === "design" ? transformDesignOutput : undefined,
            );
    }
    if ("failure" in drafted) {
      return { lens, omissions: [], blemishes: [], immutability: [], failure: drafted.failure };
    }
    if ("absence" in drafted) {
      return { lens, omissions: [], blemishes: [], immutability: [], absence: drafted.absence };
    }
    validated = drafted;
  }

  if (lens === "design") {
    const grounded = await groundDesignCoverage(validated.board, deps);
    validated = {
      ...validated,
      board:
        deps.designArtifacts === undefined || deps.designArtifacts === null
          ? stripDesignHostClaims(grounded)
          : projectDesignTaskProgress(grounded, deps.designArtifacts),
    };
  }

  let findingResolutions: readonly FindingResolution[] | undefined;
  let findingDispositions: Readonly<Record<string, FindingDisposition>> | undefined;
  if (deps.round !== undefined) {
    if (lens === "flagged" && deps.readFindingDispositions !== undefined) {
      try {
        findingDispositions = deps.readFindingDispositions();
      } catch (error) {
        return {
          lens,
          omissions: validated.omissions,
          blemishes: validated.blemishes,
          immutability: validated.immutability,
          failure: `flagged finding disposition read failed — ${error instanceof Error ? error.message : String(error)}.`,
        };
      }
    } else {
      findingDispositions = deps.round.findingDispositions;
    }
    const composition = composeFindingRound({
      lens,
      current: validated.board,
      previous: deps.previous?.get(lens),
      previousGeneration: deps.round.previousGeneration,
      previousBoardId: deps.round.previousFlaggedBoardId,
      report: reportBoard ?? { elements: [] },
      roundNumber: deps.round.number,
      dispatchedAsks: deps.round.dispatchedAsks,
      findingDispositions,
    });
    if (lens === "flagged") findingResolutions = composition.resolutions;
    validated = {
      ...validated,
      board: composition.board,
    };
  }

  if (lens === "flagged") {
    const visibleElements = reachableFindingElements(validated.board.elements);
    validated = {
      ...validated,
      board: {
        ...validated.board,
        document: finalizedFlaggedDocument(validated.board.document, visibleElements),
      },
    };
  }

  if (validated.board.elements.length === 0) {
    const absence = EMPTY_LENS_ABSENCE[lens];
    if (absence !== undefined) {
      return {
        lens,
        omissions: validated.omissions,
        blemishes: validated.blemishes,
        immutability: validated.immutability,
        absence,
      };
    }
    return {
      lens,
      omissions: validated.omissions,
      blemishes: validated.blemishes,
      immutability: validated.immutability,
      failure: `${lens} lens: produced zero elements after one explicit retry; retry the generation to draft this required board.`,
    };
  }

  const boardId = deps.boardIdFor(lens);

  if (
    lens === "flagged" &&
    findingResolutions !== undefined &&
    findingDispositions !== undefined &&
    deps.persistFindingResolutions !== undefined
  ) {
    try {
      await deps.persistFindingResolutions(
        pipelineGenerationId(deps),
        boardId,
        findingResolutions,
        findingDispositions,
      );
    } catch (error) {
      return {
        lens,
        omissions: validated.omissions,
        blemishes: validated.blemishes,
        immutability: validated.immutability,
        findingResolutions,
        failure: `flagged finding resolution persistence failed — ${error instanceof Error ? error.message : String(error)}.`,
      };
    }
  }

  // R58 delta stamps against the prior generation's board (cluster 4).
  const stamped = stampDeltas(deps.previous?.get(lens), validated.board);

  // Write the board and INSPECT the response (finding 2): a rejected batch is a lens
  // failure, never announced as arrived. On acceptance the coverage/validation
  // metadata is durably stored (finding 3). Arrival is NOT emitted here — the pipeline
  // announces lens arrivals only after cross-lens coverage runs over the frozen set.
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
    ...(findingResolutions === undefined ? {} : { findingResolutions }),
  };
}
