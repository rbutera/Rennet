import { readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { DesignArtifactSet, ProviderTurnSettlement, WhiteboardClient } from "@rennet/adapters";
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
  elementReferences,
  type FindingResolution,
  type HarnessPort,
  type HarnessTurnResult,
  isCarriedForward,
  isScaffoldPath,
  type LintContext,
  type LintHunk,
  type LintTarget,
  lint,
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
  REVIEW_DRAFT_VOICE_FILE,
  ROUND_REPORT_FILE,
  renderLayer,
} from "@rennet/prompts";
import {
  type BoardDocument,
  type ComposableAsk,
  type CouncilEffort,
  type CouncilHarnessId,
  type CouncilJobId,
  type CouncilModel,
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
  type RoundReportDiagnosticMilestone,
  resolveBoardDocument,
  SEVERITY_LEVELS,
  type Violation,
} from "@rennet/protocol";
import { z } from "zod";
import { projectRoundReportBoard } from "./lens-board-read";
import {
  CLASSIFIED_ROUND_REPORT_AUTHOR,
  CLASSIFIED_ROUND_REPORT_SECTION_ID,
  CLASSIFIED_ROUND_REPORT_SECTION_TITLE,
  CLASSIFIED_ROUND_REPORT_STATUS_ORDER,
  classifiedRoundReportIntro,
  verifyRoundReportEvidence,
} from "./round-report-verification";

/**
 * The lens drafting pipeline SCHEDULER (#464 + #493 + #486, B08 cluster 5): the
 * `server/runtime/` home the packet names, the direct sibling of B06's
 * `council-seat-turn.ts`. It seeds one drafter harness session per lens IN THE PR
 * WORKTREE with the inlined DeltaPacket (B5) + the lens prompt (`@rennet/prompts`)
 * + the host board schema (D1), validates each structured return through the
 * cluster-3 loop (`validateDraft` over `parseDraft`/`lint`), and — as the SOLE
 * op writer — writes the validated board through `whiteboard-client` (the drafters
 * never call whiteboard tools). Council-routed: every seat resolves through
 * `resolveAssignment` on the RESOLVED harness (Claude port / Codex utility
 * executor), exactly the B06 `councilSeatTurn` precedent.
 *
 * It is PURE over injected seams — the harness ports, a `readPrompt` file seam,
 * and the whiteboard writer — so the gate exercises the real path with a fake
 * `runTurn` and never makes a live model call (D-seam, like B06's swarm tests).
 *
 * ── Wiring points (packet 5.1 "record the wiring point in the ledger") ──
 *   - postProcess (validate.ts seam, identity by default) stays unused here.
 *     A second model turn to rewrite an already-valid board doubles the common
 *     path without adding source facts; deterministic validation owns cleanup.
 *   - compositionGate (validate.ts per-board seam) STAYS no-op; the cross-lens
 *     `assertCoverage(boards, hunks)` (cluster 4) runs ONCE over the frozen board
 *     set here, after every lens freezes — never per board.
 */

// ── The board output schema (the host schema the drafter's session is constrained to) ──

let cachedBoardSchema: unknown;
const RoundReportEvidenceSchema = z
  .object({
    path: z.string().min(1),
    side: z.enum(["base", "head"]),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  })
  .strict()
  .refine((evidence) => evidence.startLine === evidence.endLine, {
    message: "evidence must cite one exact changed line",
  });
const RoundReportClassificationSchema = z
  .object({
    outcomes: z.array(
      z.discriminatedUnion("status", [
        z
          .object({
            askId: z.string().min(1),
            status: z.literal("addressed"),
            note: z.string().trim().min(1),
            evidence: RoundReportEvidenceSchema,
          })
          .strict(),
        z
          .object({
            askId: z.string().min(1),
            status: z.literal("partial"),
            note: z.string().trim().min(1),
            evidence: RoundReportEvidenceSchema,
          })
          .strict(),
        z
          .object({
            askId: z.string().min(1),
            status: z.literal("untouched"),
            note: z.string().trim().min(1),
          })
          .strict(),
      ]),
    ),
    beyond: z.array(
      z
        .object({
          ref: z.string().min(1),
          text: z.string().trim().min(1),
          note: z.string().trim().min(1),
          evidence: RoundReportEvidenceSchema,
        })
        .strict(),
    ),
  })
  .strict();
type RoundReportClassification = z.infer<typeof RoundReportClassificationSchema>;
let cachedRoundReportClassificationSchema: unknown;
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

function roundReportClassificationOutputSchema(): unknown {
  if (cachedRoundReportClassificationSchema !== undefined) {
    return cachedRoundReportClassificationSchema;
  }
  try {
    cachedRoundReportClassificationSchema = z.toJSONSchema(RoundReportClassificationSchema, {
      io: "output",
    });
  } catch {
    cachedRoundReportClassificationSchema = {
      type: "object",
      required: ["outcomes", "beyond"],
      properties: {
        outcomes: { type: "array" },
        beyond: { type: "array" },
      },
    };
  }
  return cachedRoundReportClassificationSchema;
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

/** Keep recovery deletes behind the same sole board-op writer as normal draft writes. */
export async function deleteBoardElements(
  whiteboard: Pick<WhiteboardClient, "apply">,
  boardId: string,
  elementIds: readonly string[],
  actor: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string }> {
  const result = await whiteboard.apply(
    boardId,
    elementIds.map((id) => ({ op: "delete" as const, id })),
    actor,
  );
  return result.response.ok
    ? { ok: true }
    : { ok: false, code: (result.response as { code?: string }).code ?? "rejected" };
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

/** Domain elements the served board can reach from its top-level section roots. */
function reachableElementsOfKind(
  elements: readonly DraftElement[],
  kind: DraftElement["kind"],
): DraftElement[] {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const nested = new Set<string>();
  for (const element of elements) {
    const children = element.data.children;
    if (!Array.isArray(children)) continue;
    for (const child of children) if (typeof child === "string") nested.add(child);
  }

  const matches: DraftElement[] = [];
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const element = byId.get(id);
    if (element === undefined) return;
    if (element.kind === kind) matches.push(element);
    if (element.kind !== "section" && element.kind !== "order_step") return;
    for (const child of element.data.children) visit(child);
  };

  for (const element of elements) {
    if (element.kind === "section" && !nested.has(element.id)) visit(element.id);
  }
  return matches;
}

const MATERIAL_KIND_BY_LENS: Partial<Record<LensKind, DraftElement["kind"]>> = {
  sequence: "order_step",
  decisions: "decision",
  flagged: "finding",
};

/** Whether a lens produced content the served board can actually render as its result. */
function hasLensMaterial(lens: LensKind, board: DraftBoard): boolean {
  const kind = MATERIAL_KIND_BY_LENS[lens];
  return kind === undefined
    ? board.elements.length > 0
    : reachableElementsOfKind(board.elements, kind).length > 0;
}

/** Only a parsed, zero-element provider return can support a typed clean absence. */
function isTrulyEmptyDraft(output: unknown): boolean {
  const parsed = DraftBoardSchema.safeParse(output);
  return parsed.success && parsed.data.elements.length === 0;
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
 * The drafter's base prompt: the lens instructions (payload), the reviewed-range
 * task line, and the packet's INVENTORY (context). The session's cwd IS the
 * reviewed checkout, so the prompt carries identity and derived signals — the
 * hunk index WITHOUT its verbatim bodies — and the drafter reads the change
 * itself with its own tools. Inlining the whole diff here is what used to blow
 * the model's context on any large branch: the capture cap (2 MB) sits far
 * above what a prompt can carry, and no budget stood between them. Every turn
 * re-sends this — the harness turn builders open a fresh session per call, so
 * nothing may rely on prior turn state.
 */
export function renderDrafterPrompt(
  promptText: string,
  packet: DeltaPacket,
  reportBoard?: DraftBoard,
  designArtifacts?: DesignArtifactSet,
  hostSchema: unknown = boardOutputSchema(),
  round?: RoundDraftContext,
  options?: {
    /**
     * Drop the reviewed-range task layer. The legacy round-report seat verifies
     * the exact TURN diff (`round.worker.diff`), and telling it to read the
     * whole branch range would name a second, contradicting range.
     */
    readonly omitTaskLayer?: boolean;
  },
): string {
  // The hunk INDEX travels (coverage is taught-or-skipped over these exact
  // ids); the verbatim bodies do not — the drafter reads content from the
  // checkout it is standing in. Optional-chained: legacy callers and fixtures
  // hand partial packets, and a missing index is an honest empty inventory.
  const hunkIndex = (packet.hunks?.hunks ?? []).map(({ id, path, header, spans, lossy }) => ({
    id,
    path,
    header,
    spans,
    lossy,
  }));
  const context = JSON.stringify({
    deltaPacket: { ...packet, hunks: { hunks: hunkIndex } },
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
  const repo = packet.patchset?.repository;
  // A local working-tree capture pins the reviewed bytes as `reviewedTreeOid` —
  // `baseOid..headOid` there would show only the COMMITTED subset and silently
  // omit uncommitted work (the flagship "review my agent's branch" flow). The
  // diff command must name the pinned tree when one exists.
  const diffCommand =
    repo === undefined
      ? "`git diff`"
      : repo.reviewedTreeOid === undefined
        ? `\`git diff ${repo.baseOid}..${repo.headOid}\``
        : `\`git diff ${repo.baseOid} ${repo.reviewedTreeOid}\``;
  const task = [
    repo === undefined
      ? "Your working directory IS the reviewed checkout."
      : repo.reviewedTreeOid === undefined
        ? `You are reviewing the commits since ${repo.baseOid} (${repo.baseRef}); your working directory IS the reviewed checkout at ${repo.headOid}.`
        : `You are reviewing the working-tree change since ${repo.baseOid} (${repo.baseRef}), pinned as tree ${repo.reviewedTreeOid}; your working directory IS the reviewed checkout, including uncommitted work.`,
    "The context layer carries the change INVENTORY (file rows, hunk ids/headers/spans, derived signals) — not the diff content.",
    `Read the change yourself with your own tools (${diffCommand}, \`git log\`, file reads, grep) and cite only what you actually read.`,
  ].join("\n");
  if (options?.omitTaskLayer === true) {
    return `${renderLayer("payload", promptText)}\n\n${renderLayer("context", context)}`;
  }
  return `${renderLayer("payload", promptText)}\n\n${renderLayer("task", task)}\n\n${renderLayer("context", context)}`;
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

// ── The prompt-file reader seam (prompts is node-free; the caller resolves files) ──

/** Read a prompt file from an on-disk copy of the `@rennet/prompts` src dir. */
export type PromptReader = (file: string) => string | Promise<string>;

/**
 * The default node reader: resolves prompt file names against `promptsSrcDir`.
 *
 * Memoized per file (perf audit §4 M): a round reads every lens prompt for every lens,
 * and prompt files are shipped alongside the daemon — they cannot change while it runs.
 * The memo is per-reader, so its lifetime is the composition that created it and a test
 * that builds a second reader over a different dir shares nothing with the first.
 */
export function createNodePromptReader(promptsSrcDir: string): PromptReader {
  const cache = new Map<string, string>();
  return (file: string) => {
    const hit = cache.get(file);
    if (hit !== undefined) return hit;
    const text = readFileSync(join(promptsSrcDir, file), "utf8");
    cache.set(file, text);
    return text;
  };
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

/** A report already durably written under this drafting attempt's reserved identity. */
export interface ReusableRoundReport {
  readonly boardId: string;
  readonly board: DraftBoard;
  readonly omissions: readonly Omission[];
  readonly blemishes: readonly Violation[];
  readonly immutability: readonly Violation[];
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
  /** The change inventory the drafter prompts carry (hunk bodies redacted at render). */
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
  /** Exact report state recovered from this attempt's reserved board after a restart.
   *  The pipeline re-verifies it against the worker receipt before announcing or reusing
   *  it, and never opens another report provider turn when this candidate is present. */
  readonly reusableRoundReport?: ReusableRoundReport;
  /** Remove stale report metadata before clearing a recovered report board. */
  readonly removeBoardMeta?: (boardId: string) => void | Promise<void>;
  /** The per-board arrival broadcast (B09 consumes; optional). */
  readonly onBoardArrival?: (event: BoardArrivalEvent) => void | Promise<void>;
  /** Content-free timing checkpoints for a classified round report only. */
  readonly onReportDiagnostic?: (milestone: RoundReportDiagnosticMilestone) => void;
  /** A successful lens absence, emitted as soon as discovery settles it. */
  readonly onLensAbsence?: (lens: LensKind, reason: LensAbsenceReason) => void | Promise<void>;
  /**
   * The lens drafters are about to start. Fires exactly once per pipeline, immediately
   * before the first lens drafts. A required report must already have arrived; a report
   * failure aborts the pipeline before this callback or any lens seat starts.
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
  /** Clock seam for integer report milestone timing. */
  readonly now?: () => number;
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

type LandedRoundDraftContext = RoundDraftContext & {
  readonly worker: NonNullable<RoundDraftContext["worker"]>;
};

/**
 * The report classifier receives only the identity and evidence needed to judge this
 * coding turn. The full DeltaPacket and all-kind board schema belong to lens drafting,
 * not to the per-ask classification boundary.
 */
export function renderRoundReportClassifierPrompt(
  promptText: string,
  patchsetId: string,
  round: LandedRoundDraftContext,
): string {
  const context = JSON.stringify({
    patchsetId,
    dispatchedAsks: round.dispatchedAsks.map(({ id, path, instruction, span, side }) => ({
      id,
      path,
      instruction,
      ...(span === undefined ? {} : { span }),
      ...(side === undefined ? {} : { side }),
    })),
    worker: round.worker,
  });
  return `${renderLayer("payload", promptText)}\n\n${renderLayer("context", context)}`;
}

type ClassifiedRoundOutcome =
  | {
      readonly status: "addressed" | "partial" | "untouched";
      readonly ref: string;
      readonly text: string;
      readonly note: string;
      readonly evidence?: z.infer<typeof RoundReportEvidenceSchema>;
    }
  | {
      readonly status: "beyond";
      readonly ref: string;
      readonly text: string;
      readonly note: string;
      readonly evidence: z.infer<typeof RoundReportEvidenceSchema>;
    };

function classifiedRoundOutcomes(
  classification: RoundReportClassification,
  asks: readonly ComposableAsk[],
): ClassifiedRoundOutcome[] {
  const known = new Set(asks.map((ask) => ask.id));
  const byAsk = new Map<string, RoundReportClassification["outcomes"][number]>();
  for (const outcome of classification.outcomes) {
    if (!known.has(outcome.askId)) {
      throw new Error(`contains unknown dispatched ask ${outcome.askId}`);
    }
    if (byAsk.has(outcome.askId)) {
      throw new Error(`repeats dispatched ask ${outcome.askId}`);
    }
    if (outcome.status !== "untouched" && outcome.evidence.endLine < outcome.evidence.startLine) {
      throw new Error(`outcome for ${outcome.askId} has an inverted diff evidence range`);
    }
    byAsk.set(outcome.askId, outcome);
  }

  for (const outcome of classification.beyond) {
    if (outcome.evidence.endLine < outcome.evidence.startLine) {
      throw new Error(`beyond outcome ${outcome.ref} has an inverted diff evidence range`);
    }
  }

  const missing = asks.filter((ask) => !byAsk.has(ask.id)).map((ask) => ask.id);
  if (missing.length > 0) throw new Error(`omitted dispatched asks: ${missing.join(", ")}`);

  const outcomes: ClassifiedRoundOutcome[] = asks.map((ask) => {
    const classified = byAsk.get(ask.id);
    if (classified === undefined) throw new Error(`omitted dispatched ask ${ask.id}`);
    return classified.status === "untouched"
      ? {
          status: classified.status,
          ref: ask.id,
          text: ask.instruction,
          note: classified.note,
        }
      : {
          status: classified.status,
          ref: ask.id,
          text: ask.instruction,
          note: classified.note,
          evidence: classified.evidence,
        };
  });
  outcomes.sort(
    (left, right) =>
      CLASSIFIED_ROUND_REPORT_STATUS_ORDER.indexOf(left.status) -
      CLASSIFIED_ROUND_REPORT_STATUS_ORDER.indexOf(right.status),
  );
  const beyond: ClassifiedRoundOutcome[] = classification.beyond
    .map((outcome) => ({
      status: "beyond" as const,
      ref: outcome.ref,
      text: outcome.text,
      note: outcome.note,
      evidence: outcome.evidence,
    }))
    .sort((left, right) => left.ref.localeCompare(right.ref));
  return [...outcomes, ...beyond];
}

function buildClassifiedRoundReport(
  classification: RoundReportClassification,
  round: LandedRoundDraftContext,
  patchsetId: string,
): DraftBoard {
  const outcomes = classifiedRoundOutcomes(classification, round.dispatchedAsks);
  const elements: DraftElement[] = [];
  const outcomeIds: string[] = [];
  for (const [index, outcome] of outcomes.entries()) {
    const outcomeId = `rennet:host:round-report:${index}:outcome`;
    const codeRefId = `rennet:host:round-report:${index}:code`;
    outcomeIds.push(outcomeId);
    if (outcome.evidence !== undefined) {
      elements.push({
        id: codeRefId,
        kind: "code_ref",
        data: {
          author: CLASSIFIED_ROUND_REPORT_AUTHOR,
          patchset_id: patchsetId,
          path: outcome.evidence.path,
          side: outcome.evidence.side,
          start_line: outcome.evidence.startLine,
          end_line: outcome.evidence.endLine,
        },
      });
    }
    elements.push({
      id: outcomeId,
      kind: "round_outcome",
      data: {
        author: CLASSIFIED_ROUND_REPORT_AUTHOR,
        status: outcome.status,
        ask: { ref: outcome.ref, text: outcome.text },
        note: outcome.note,
        ...(outcome.evidence === undefined ? {} : { code_ref: codeRefId }),
      },
    });
  }
  elements.unshift({
    id: CLASSIFIED_ROUND_REPORT_SECTION_ID,
    kind: "section",
    data: {
      author: CLASSIFIED_ROUND_REPORT_AUTHOR,
      title: CLASSIFIED_ROUND_REPORT_SECTION_TITLE,
      children: outcomeIds,
    },
  });
  return {
    document: {
      title: "Round report",
      introMarkdown: classifiedRoundReportIntro(outcomes.map((outcome) => outcome.status)),
      measure: "reading",
    },
    elements,
    skippedHunks: [],
  } as DraftBoard;
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
 * The predicate stays with the pipeline. Callers do not mirror it: `onLensDraftingStart`
 * fires exactly once after a required report arrives or the report is skipped, and promotes
 * all five independent lanes from that real kickoff boundary.
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
  const seat = resolveBoardSeatDetails(jobId, deps, council, outputSchema);
  return "failure" in seat ? { failure: seat.failure } : seat.runTurn;
}

function resolveBoardSeatDetails(
  jobId: CouncilJobId,
  deps: LensPipelineDeps,
  council: CouncilResolveContext,
  outputSchema: unknown,
  onProviderSettled?: (milestone: ProviderTurnSettlement) => void,
) {
  return councilSeatTurn(
    jobId,
    outputSchema,
    {
      claudePort: deps.claudePort,
      codexExecutor: deps.codexExecutor,
      repoRoot: deps.repoRoot,
      label: `board.${jobId}`,
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      ...(onProviderSettled === undefined ? {} : { onProviderSettled }),
    },
    council,
  );
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

function requiredBoardFailure(lens: LensKind): string {
  switch (lens) {
    case "sequence":
      return "sequence lens: produced no reachable `order_step` in the emitted board; retry the generation to draft this required board.";
    case "decisions":
      return "decisions lens: produced no reachable `decision` in the emitted board; retry the generation to distinguish decisions from malformed output.";
    case "flagged":
      return "flagged lens: produced no reachable `finding` in the emitted board; retry the generation to distinguish findings from malformed output.";
    default:
      return `${lens} lens: produced zero elements in the emitted board; retry the generation to draft this required board.`;
  }
}

/**
 * Draft one lens: seed the seat, run the cluster-3 deterministic validation loop,
 * and return the validated board — or an honest `failure` (finding 6). A failure is recorded, never a
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
  ctx: LintContext,
  transformOutput?: (output: unknown) => unknown,
): Promise<DraftedLens | { readonly failure: string }>;
function draftOneLens(
  basePrompt: string,
  seatTurn: (prompt: string, attempt: number) => Promise<HarnessTurnResult>,
  ctx: LintContext,
  transformOutput: (output: unknown) => unknown,
  initialAbsence: (output: unknown) => { readonly absence: "no-material" } | undefined,
): Promise<DraftedLens | { readonly failure: string } | { readonly absence: "no-material" }>;
async function draftOneLens(
  basePrompt: string,
  seatTurn: (prompt: string, attempt: number) => Promise<HarnessTurnResult>,
  ctx: LintContext,
  transformOutput: (output: unknown) => unknown = (output) => output,
  initialAbsence?: (output: unknown) => { readonly absence: "no-material" } | undefined,
): Promise<DraftedLens | { readonly failure: string } | { readonly absence: "no-material" }> {
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
    const transformedFirst = transformOutput(first.body);
    const initialOutputWasEmpty = isTrulyEmptyDraft(transformedFirst);
    let retryAbsence: { readonly absence: "no-material" } | undefined;
    let validated: Awaited<ReturnType<typeof validateDraft>>;
    try {
      validated = await validateDraft(transformedFirst, ctx, {
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
    return { ...validated, initialOutputWasEmpty };
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

/**
 * Run the lens drafting pipeline for one generation. Seeds the five lens
 * drafters, validates + writes each board, emits per-board
 * arrival on freeze, and runs the cross-lens coverage assert ONCE over the
 * frozen set. A required report is the one sequencing boundary: it must exist before fanout.
 * Individual lens failures remain recorded outcomes rather than throws.
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

  // Whether a report drafts at all is `draftsRoundReport` (R58/D3, defined with the
  // predicate). It drafts FIRST and announces its own arrival, ahead of every lens.
  const reportRequired = draftsRoundReport(deps);
  const report = reportRequired ? await runRoundReport(deps, council) : undefined;
  if (reportRequired && report?.board === undefined) {
    throw new Error(
      report?.failure ??
        "round-report seat: required report did not produce a board; retry the generation.",
    );
  }
  const reportBoard = report?.board;

  // A required report has arrived, or this generation does not need one. Only now may the
  // independent lens seats start; report failure exits above without launching hidden work.
  deps.onLensDraftingStart?.();

  // Each lens owns a distinct seat, board id, and metadata record, so the five drafts can
  // run independently once the report gate settles. Absence notifications are the one
  // cumulative persistence seam: serialize them in settlement order, and keep the tail
  // alive after a rejected callback so one failed save cannot suppress a later absence.
  let absenceNotificationTail = Promise.resolve();
  const notifyAbsence = (lens: LensKind, reason: LensAbsenceReason): Promise<void> => {
    const notification = absenceNotificationTail.then(() => deps.onLensAbsence?.(lens, reason));
    absenceNotificationTail = notification.then(
      () => undefined,
      () => undefined,
    );
    return notification;
  };
  const settledOutcomes = await Promise.allSettled(
    LENS_KINDS.map(async (lens) => {
      const outcome = await runLensBoard(lens, deps, council, reportBoard);
      if (outcome.absence !== undefined) await notifyAbsence(lens, outcome.absence);
      return outcome;
    }),
  );
  // Wait for every launched lane before propagating an unexpected infrastructure error.
  // Array order remains LENS_KINDS even when persistence completed in another order.
  const outcomes = settledOutcomes.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });

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
      await deps.onBoardArrival?.({
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

/** The production round report: one semantic classification turn, deterministic shape. */
function verifyClassifiedRoundReport(
  deps: LensPipelineDeps,
  round: LandedRoundDraftContext,
  boardId: string,
  board: DraftBoard,
): void {
  const projected = projectRoundReportBoard(board.elements, {
    lens: "report",
    generation: pipelineGenerationId(deps),
    boardId,
    document: board.document,
    skippedHunks: boardSkippedHunks(board),
  });
  verifyRoundReportEvidence({
    board: projected,
    dispatchedAsks: round.dispatchedAsks,
    expectedPatchsetId: deps.deltaPacket.patchset.id,
    diff: round.worker.diff,
    changedPaths: round.worker.changedPaths,
  });
}

async function reuseClassifiedRoundReport(
  deps: LensPipelineDeps,
  round: LandedRoundDraftContext,
  report: ReusableRoundReport,
): Promise<LensBoardOutcome | undefined> {
  const boardId = deps.boardIdFor("report");
  if (report.boardId !== boardId) {
    return {
      lens: "report",
      omissions: [],
      blemishes: [],
      immutability: [],
      failure: `round-report seat: reusable report ${report.boardId} does not match reserved board ${boardId}.`,
    };
  }
  try {
    verifyClassifiedRoundReport(deps, round, boardId, report.board);
  } catch (error) {
    try {
      await deps.removeBoardMeta?.(boardId);
    } catch (removeError) {
      return {
        lens: "report",
        omissions: report.omissions,
        blemishes: report.blemishes,
        immutability: report.immutability,
        failure: `round-report seat: reusable report failed verification and its metadata could not be removed — ${
          removeError instanceof Error ? removeError.message : String(removeError)
        }`,
      };
    }
    const elementIds = draftToOps(report.board)
      .reverse()
      .map(({ element }) => element.id);
    const cleared = await deleteBoardElements(
      deps.whiteboard,
      boardId,
      elementIds,
      "host:round-report-recovery",
    );
    if (!cleared.ok) {
      return {
        lens: "report",
        omissions: report.omissions,
        blemishes: report.blemishes,
        immutability: report.immutability,
        failure: `round-report seat: reusable report failed verification and its reserved board could not be cleared (${cleared.code}) — ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    // A stale or corrupt candidate must not poison every retry. Once its reserved board
    // is empty, fall through to the same single classification turn as a fresh attempt;
    // the new metadata overwrites the stale record after the replacement board lands.
    return undefined;
  }
  await deps.onBoardArrival?.({
    lens: "report",
    boardId,
    elementCount: report.board.elements.length,
    carried: isCarriedForward(deps.previous?.get("report"), report.board),
  });
  return {
    lens: "report",
    boardId,
    board: report.board,
    omissions: report.omissions,
    blemishes: report.blemishes,
    immutability: report.immutability,
  };
}

function roundReportTurnStartedMilestone(
  seat: {
    readonly harness: CouncilHarnessId;
    readonly model: CouncilModel;
    readonly effort: CouncilEffort;
  },
  elapsedMs: number,
): RoundReportDiagnosticMilestone | undefined {
  if (seat.harness === "claude-code") {
    switch (seat.model) {
      case "haiku":
      case "sonnet-5":
      case "opus-4.8":
        return {
          stage: "turn-started",
          harness: "claude-code",
          model: seat.model,
          effort: seat.effort,
          elapsedMs,
        };
      default:
        return undefined;
    }
  }
  switch (seat.model) {
    case "gpt-5.5":
    case "gpt-5.6-sol":
    case "gpt-5.6-terra":
    case "gpt-5.6-luna":
      return {
        stage: "turn-started",
        harness: "codex",
        model: seat.model,
        effort: seat.effort,
        elapsedMs,
      };
    default:
      return undefined;
  }
}

async function runClassifiedRoundReport(
  deps: LensPipelineDeps,
  council: CouncilResolveContext,
  round: LandedRoundDraftContext,
): Promise<LensBoardOutcome | undefined> {
  const now = deps.now ?? (() => performance.now());
  const startedAt = now();
  let lastElapsedMs = 0;
  const elapsedMs = (): number => {
    const elapsed = now() - startedAt;
    const measured = Number.isFinite(elapsed) ? Math.max(0, Math.floor(elapsed)) : 0;
    lastElapsedMs = Math.max(lastElapsedMs, measured);
    return lastElapsedMs;
  };
  const emitDiagnostic = (milestone: RoundReportDiagnosticMilestone): void => {
    try {
      deps.onReportDiagnostic?.(milestone);
    } catch {
      // Report-only diagnostics never change the classified result they describe.
    }
  };
  const seat = resolveBoardSeatDetails(
    "round-report",
    deps,
    council,
    roundReportClassificationOutputSchema(),
    (milestone) => emitDiagnostic({ ...milestone, elapsedMs: elapsedMs() }),
  );
  if ("failure" in seat) {
    return {
      lens: "report",
      omissions: [],
      blemishes: [],
      immutability: [],
      failure: `round-report seat: ${seat.failure}`,
    };
  }

  const promptText = await deps.readPrompt(ROUND_REPORT_FILE);
  const prompt = renderRoundReportClassifierPrompt(promptText, deps.deltaPacket.patchset.id, round);
  const turnStarted = roundReportTurnStartedMilestone(seat, elapsedMs());
  if (turnStarted !== undefined) emitDiagnostic(turnStarted);
  let turn: HarnessTurnResult;
  try {
    turn = await seat.runTurn(prompt, 0);
  } catch (error) {
    emitDiagnostic({ stage: "turn-settled", status: "failed", elapsedMs: elapsedMs() });
    return {
      lens: "report",
      omissions: [],
      blemishes: [],
      immutability: [],
      failure: `round-report seat: classification turn threw — ${
        error instanceof Error ? error.message : String(error)
      }.`,
    };
  }
  emitDiagnostic({ stage: "turn-settled", status: turn.status, elapsedMs: elapsedMs() });
  if (turn.status !== "emitted") {
    return {
      lens: "report",
      omissions: [],
      blemishes: [],
      immutability: [],
      failure: `round-report seat: classification turn did not emit (${turn.status}: ${turn.message}).`,
    };
  }
  const parsed = RoundReportClassificationSchema.safeParse(turn.body);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "output"}: ${issue.message}`)
      .join("; ");
    return {
      lens: "report",
      omissions: [],
      blemishes: [],
      immutability: [],
      failure: `round-report seat: classification output was invalid — ${issues}.`,
    };
  }
  emitDiagnostic({ stage: "schema-parsed", elapsedMs: elapsedMs() });

  let board: DraftBoard;
  try {
    board = buildClassifiedRoundReport(parsed.data, round, deps.deltaPacket.patchset.id);
  } catch (error) {
    return {
      lens: "report",
      omissions: [],
      blemishes: [],
      immutability: [],
      failure: `round-report seat: classification ${
        error instanceof Error ? error.message : String(error)
      }.`,
    };
  }

  const stamped = stampDeltas(deps.previous?.get("report"), board);
  const boardId = deps.boardIdFor("report");
  try {
    verifyClassifiedRoundReport(deps, round, boardId, stamped);
  } catch (error) {
    return {
      lens: "report",
      omissions: [],
      blemishes: [],
      immutability: [],
      failure: `round-report seat: deterministic verification failed — ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  emitDiagnostic({ stage: "evidence-verified", elapsedMs: elapsedMs() });

  const validated: ValidatedLike = {
    board: stamped,
    omissions: [],
    blemishes: lint(stamped, deps.lintContextFor("report")),
    immutability: [],
  };
  const persisted = await persistBoard(deps, "report", boardId, stamped, validated, "seat:report");
  if (!persisted.ok) {
    return {
      lens: "report",
      omissions: [],
      blemishes: validated.blemishes,
      immutability: [],
      failure: persisted.reason,
    };
  }
  emitDiagnostic({ stage: "persisted", elapsedMs: elapsedMs() });
  await deps.onBoardArrival?.({
    lens: "report",
    boardId,
    elementCount: stamped.elements.length,
    carried: isCarriedForward(deps.previous?.get("report"), stamped),
  });
  return {
    lens: "report",
    boardId,
    board: stamped,
    omissions: [],
    blemishes: validated.blemishes,
    immutability: [],
  };
}

/** Legacy callers without an exact worker receipt keep the old generic board path. */
async function runLegacyRoundReport(
  deps: LensPipelineDeps,
  council: CouncilResolveContext,
): Promise<LensBoardOutcome | undefined> {
  const seat = resolveBoardSeat("round-report", deps, council);
  if ("failure" in seat) {
    return {
      lens: "report",
      omissions: [],
      blemishes: [],
      immutability: [],
      failure: `round-report seat: ${seat.failure}`,
    };
  }

  const promptText = await deps.readPrompt(ROUND_REPORT_FILE);
  const basePrompt = renderDrafterPrompt(
    promptText,
    deps.deltaPacket,
    undefined,
    undefined,
    boardOutputSchema(),
    deps.round,
    // The report verifies the exact turn diff (`round.worker.diff`); the
    // reviewed-range task line would name a second, contradicting range.
    { omitTaskLayer: true },
  );
  const ctx = deps.lintContextFor("report");
  const validated = await draftOneLens(basePrompt, seat, ctx);
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
        "round-report seat: produced zero elements in the emitted board; retry the generation to draft this required board.",
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
  await deps.onBoardArrival?.({
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

/**
 * Draft the report before lens fanout. Landed production rounds use the compact
 * classifier; only legacy callers without exact worker evidence use generic board drafting.
 */
async function runRoundReport(
  deps: LensPipelineDeps,
  council: CouncilResolveContext,
): Promise<LensBoardOutcome | undefined> {
  if (deps.round?.worker !== undefined) {
    const round = deps.round as LandedRoundDraftContext;
    if (deps.reusableRoundReport !== undefined) {
      const reused = await reuseClassifiedRoundReport(deps, round, deps.reusableRoundReport);
      if (reused !== undefined) return reused;
    }
    return runClassifiedRoundReport(deps, council, round);
  }
  return runLegacyRoundReport(deps, council);
}

/** Draft, validate, write, and announce one lens board. */
/** The shape the common tail needs — one seat's or the reconciled dual seat's. */
interface ValidatedLike {
  readonly board: DraftBoard;
  readonly omissions: readonly Omission[];
  readonly blemishes: readonly Violation[];
  readonly immutability: readonly Violation[];
}

/** A validated lens result plus the provider-return fact that authorizes clean absence. */
interface DraftedLens extends ValidatedLike {
  readonly initialOutputWasEmpty: boolean;
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
  basePrompt: string,
  ctx: LintContext,
): Promise<DraftedLens | { failure: string }> {
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
    const single = await draftOneLens(basePrompt, seat, ctx);
    if ("failure" in single) return { failure: single.failure };
    return { ...single, board: stampSingleSeatConcurrence(single.board, label) };
  }

  // Both seats run independently; reconcile their findings (Claude is seat A).
  const [a, b] = await Promise.all([
    draftOneLens(
      basePrompt,
      claudeSeat as (p: string, at: number) => Promise<HarnessTurnResult>,
      ctx,
    ),
    draftOneLens(
      basePrompt,
      codexSeat as (p: string, at: number) => Promise<HarnessTurnResult>,
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
    const ok = (aOk ? a : b) as DraftedLens;
    const label = aOk ? DEFAULT_SEAT_LABELS["claude-code"] : DEFAULT_SEAT_LABELS.codex;
    return { ...ok, board: stampSingleSeatConcurrence(ok.board, label) };
  }
  const seatA = a as DraftedLens;
  const seatB = b as DraftedLens;
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
    initialOutputWasEmpty: seatA.initialOutputWasEmpty && seatB.initialOutputWasEmpty,
  };
}

async function runLensBoard(
  lens: LensKind,
  deps: LensPipelineDeps,
  council: CouncilResolveContext,
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

  let validated: DraftedLens;
  if (lens === "flagged") {
    // The flagged lens is the dual seat (Claude + Codex, cross-model concurrence).
    const dual = await runFlaggedDual(deps, basePrompt, ctx);
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
    const drafted =
      semanticDesignAbsence && deps.designArtifacts !== undefined && deps.designArtifacts !== null
        ? await draftOneLens(basePrompt, seat, ctx, transformDesignOutput, (output) =>
            groundedDesignAbsence(output, deps.designArtifacts as DesignArtifactSet),
          )
        : await draftOneLens(
            basePrompt,
            seat,
            ctx,
            lens === "design" ? transformDesignOutput : undefined,
          );
    if ("failure" in drafted) {
      return { lens, omissions: [], blemishes: [], immutability: [], failure: drafted.failure };
    }
    if ("absence" in drafted) {
      return { lens, omissions: [], blemishes: [], immutability: [], absence: drafted.absence };
    }
    validated = drafted;
  }

  if (!hasLensMaterial(lens, validated.board)) {
    const absence = validated.initialOutputWasEmpty ? EMPTY_LENS_ABSENCE[lens] : undefined;
    if (absence === undefined) {
      return {
        lens,
        omissions: validated.omissions,
        blemishes: validated.blemishes,
        immutability: validated.immutability,
        failure: requiredBoardFailure(lens),
      };
    }
    // A round's empty Flagged result still owns disposition migration. Let it pass
    // through composeFindingRound and persistFindingResolutions before the final
    // no-findings absence. Other clean absences have no round-owned state to migrate.
    if (lens !== "flagged" || deps.round === undefined) {
      return {
        lens,
        omissions: validated.omissions,
        blemishes: validated.blemishes,
        immutability: validated.immutability,
        absence,
      };
    }
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
    const visibleElements = reachableElementsOfKind(validated.board.elements, "finding");
    validated = {
      ...validated,
      board: {
        ...validated.board,
        document: finalizedFlaggedDocument(validated.board.document, visibleElements),
      },
    };
  }

  const migratesFindingResolutions =
    lens === "flagged" &&
    findingResolutions !== undefined &&
    findingDispositions !== undefined &&
    deps.persistFindingResolutions !== undefined;
  const flaggedBoardId = migratesFindingResolutions ? deps.boardIdFor(lens) : undefined;

  // A Flagged round can consume the last reachable finding while retaining its flat-pool
  // history. Migrate the reviewer-owned resolution before returning typed absence so the
  // next round does not lose the disposition merely because there is no board to serve.
  if (
    migratesFindingResolutions &&
    flaggedBoardId !== undefined &&
    findingResolutions !== undefined &&
    findingDispositions !== undefined &&
    deps.persistFindingResolutions !== undefined
  ) {
    try {
      await deps.persistFindingResolutions(
        pipelineGenerationId(deps),
        flaggedBoardId,
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

  if (!hasLensMaterial(lens, validated.board)) {
    const absence = EMPTY_LENS_ABSENCE[lens];
    if (absence !== undefined) {
      return {
        lens,
        omissions: validated.omissions,
        blemishes: validated.blemishes,
        immutability: validated.immutability,
        ...(findingResolutions === undefined ? {} : { findingResolutions }),
        absence,
      };
    }
    return {
      lens,
      omissions: validated.omissions,
      blemishes: validated.blemishes,
      immutability: validated.immutability,
      failure: requiredBoardFailure(lens),
    };
  }

  const boardId = flaggedBoardId ?? deps.boardIdFor(lens);

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
