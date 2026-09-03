import { readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type {
  DesignArtifactSet,
  MetricsCollector,
  ProviderTurnSettlement,
  T3SeatSeam,
  WhiteboardClient,
} from "@rennet/adapters";
import { councilSeatTurn, fitDesignArtifactsToBytes } from "@rennet/adapters";
import {
  type CodexExecutor,
  carriedElementIds,
  composeFindingRound,
  DEFAULT_SEAT_LABELS,
  type DeltaPacket,
  type DesignTaskProgressSource,
  deriveDesignTaskProgress,
  type ElementReference,
  elementReferences,
  type FindingResolution,
  type HarnessPort,
  type HarnessTurnResult,
  HOST_COMPOSER_AUTHOR_ID,
  HOST_ROUND_HISTORY_PREFIX,
  isCarriedForward,
  type LintContext,
  type LintTarget,
  lint,
  lintReviewDraft,
  NO_CONCERN_ANSWER,
  type Omission,
  parseDesignSourceObligations,
  type RegisterLintContext,
  reconcileFindingsWithProvenance,
  stampDeltas,
  validateDraft,
} from "@rennet/core";
import {
  expandPromptPartials,
  INVESTIGATE_PARTIAL_FILE,
  LENS_PROMPT_FILES,
  REVIEW_DRAFT_VOICE_FILE,
  ROUND_REPORT_FILE,
  renderLayer,
  renderRepairTurn,
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
  type GenerationPhaseTiming,
  generationIdForPatchset,
  LENS_ADMISSIBLE_ABSENCES,
  LENS_KINDS,
  type LensAbsenceReason,
  type LensFailureAccount,
  type LensKind,
  parseDraft,
  ROUND_REPORT_MAX_BEYOND_ENTRIES,
  ROUND_REPORT_OUTPUT_MAX_BYTES,
  ROUND_REPORT_OUTPUT_MAX_TOKENS,
  type RoundEvidenceAnchor,
  type RoundEvidenceUnit,
  type RoundReportDiagnosticMilestone,
  resolveBoardDocument,
  SEVERITY_LEVELS,
  type Violation,
} from "@rennet/protocol";
import { z } from "zod";
import { T3_TURN_INPUT_MAX_CHARS } from "../t3/client";
import type { SeatKind as BoardSeatId } from "../t3/threads";
import { projectRoundReportBoard } from "./lens-board-read";
import {
  buildRoundEvidenceManifest,
  compareByCodeUnit,
  measureRoundEvidenceManifest,
  verifyRoundEvidencePartition,
} from "./round-evidence-manifest";
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
 *   - There is no cross-lens coverage gate (session-bound-workspace D5): a board cites
 *     what it read, lint resolves each citation against the changed regions, and
 *     nothing accounts for the regions a board did not cite.
 */

// ── The board output schema (the host schema the drafter's session is constrained to) ──

let cachedBoardSchema: unknown;
/**
 * The classifier cites MANIFEST IDS, never coordinates (#727). Every id the host put
 * in the manifest lands in exactly one bucket, and the host derives the displayed line
 * anchor from the hunk it parsed itself — so no output shape can invent a line number
 * for a rename, a mode change, or a binary file.
 */
const RoundReportEvidenceIdsSchema = z.array(z.string().min(1)).min(1);
const RoundReportClassificationSchema = z
  .object({
    outcomes: z.array(
      z.discriminatedUnion("status", [
        z
          .object({
            askId: z.string().min(1),
            status: z.literal("addressed"),
            note: z.string().trim().min(1),
            evidenceIds: RoundReportEvidenceIdsSchema,
          })
          .strict(),
        z
          .object({
            askId: z.string().min(1),
            status: z.literal("partial"),
            note: z.string().trim().min(1),
            evidenceIds: RoundReportEvidenceIdsSchema,
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
          evidenceIds: RoundReportEvidenceIdsSchema,
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
 * output schema (the SDK `outputFormat`) and NEVER inlined into the prompt: the
 * schema travels once (#737; the double-send was ~9.8 KB per turn). A
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

// ── Reference admission at the write boundary (#548 D1) ──

/** One repaired reference: what the producer cited, and the target it provably meant. */
export interface RefRepair {
  readonly elementId: string;
  readonly field: string;
  readonly from: string;
  readonly to: string;
}

/**
 * Fold an authored element id to its identity for provable-target comparison: case and
 * the separator set below are the drafter's typography, not the id's identity, so
 * `Decision_Code`, `decision-code`, `decision.code` and `decisionCode` fold together.
 *
 * LETTERS ARE NEVER DROPPED. An earlier fold stripped every character outside `[a-z0-9]`,
 * which deleted the letters themselves out of a non-ASCII id: `authé` and `authø` both
 * folded to `auth`, so two ids that differ in a LETTER became one "unique" candidate and
 * the pass repaired a reference onto an element nobody meant. Two ids that differ in a
 * letter are two different ids, and guessing between them is not proof.
 */
function refIdentity(id: string): string {
  return id.toLowerCase().replace(/[-_./\\ ]+/g, "");
}

/**
 * The element kind a reference field is declared to hold, for the fields whose
 * {@link AUTHORED_BOARD_SCHEMA} declaration names one. A field absent here (`children`,
 * `scenarios`, `alternatives`, `reply_to`, `quote_target`, `covers`) holds any kind, and
 * nothing about its target's kind is provable.
 *
 * This constrains REPAIRS only. A repair is a guess about what the producer meant, and a
 * sole folded candidate of the wrong kind is a different element — an `order_step.span`
 * folding onto a `prose` is not proof that the prose is the code the step spans. The pass
 * does NOT re-judge a reference the producer spelled exactly: that element is in the
 * document, the board service admits it, and refusing it would cost the reviewer the whole
 * board over a kind the service and the lint layer both accept (prose spans ship today).
 */
const REPAIR_TARGET_KIND: Readonly<Record<string, DraftElement["kind"]>> = {
  "annotation.code_ref": "code_ref",
  "decision.evidence": "code_ref",
  "finding.code": "code_ref",
  "message.code_ref": "code_ref",
  "noise_verdict.hunk": "code_ref",
  "order_step.span": "code_ref",
  "requirement.trace": "code_ref",
  "review_comment.code_ref": "code_ref",
  "round_outcome.code_ref": "code_ref",
};

/** Exposed for the drift test that keeps the map in step with the authored schema. */
export const REPAIR_TARGET_KINDS = REPAIR_TARGET_KIND;

export interface RefAdmission {
  /** The board with every provable repair applied; identical when there was nothing to repair. */
  readonly board: DraftBoard;
  readonly repairs: readonly RefRepair[];
  /** References with no provable unique target. Non-empty ⇒ the board must NOT be written. */
  readonly unrepairable: readonly { elementId: string; field: string; targetId: string }[];
}

/**
 * The ref-admission pass (#548 D1). Every element reference in a board about to be
 * written is checked against THAT document: the board service validates references in
 * batch order and rejects the whole write as `bad-ref` when one names an element the
 * document does not contain, so an unadmitted reference costs the lens its board.
 *
 * Lint already resolves references DURING drafting, but the board that gets written is
 * not the board lint last saw: delta stamping, the round's finding composition, the
 * Flagged document rewrite and Design coverage grounding all edit the board after the
 * ladder ends. This pass is the boundary those edits cross.
 *
 * A dangling reference is REPAIRED only when its unique intended target is provable:
 * exactly one element of this document shares the reference's identity (see
 * {@link refIdentity}), it is not the citing element itself, it is the kind the field is
 * declared to hold ({@link REPAIR_TARGET_KIND}), and — when it is a `code_ref` — it cites
 * the captured patchset this generation is reading, so the repair points into the patchset
 * the board is about. Ambiguity (two candidates) or absence (none) is not proof, and the
 * lane settles a typed failure instead. Dropping the citing element to make the rest of the
 * board acceptable is FORBIDDEN: an accepted board that silently sheds produced material
 * is the quiet lie the complete-coverage ruling exists to prevent.
 *
 * The patchset test runs on a reference the producer spelled EXACTLY too: an id that
 * happens to exist is not a licence to cite another patchset's code, and the repair path
 * already refuses exactly that candidate. Host-carried round history is the one exception,
 * and it is not an exception to the rule — a prior round's addressed chapter is ABOUT an
 * earlier generation, so its orchestrator-authored anchors cite that generation's patchset
 * by design, and every round after the first would otherwise lose its Sequence board.
 *
 * That exemption names the host composer EXACTLY ({@link isHostComposedHistory}): an
 * `orchestrator` author alone is a claim any seat can type into its output, and a lens
 * that stamped one on its own code_ref would have bought itself a licence to cite any
 * patchset it liked. Only `composeFindingRound`'s own author id, or an element the host
 * minted into its round-history namespace, clears the check.
 */
/* The two host-composer identities come from `@rennet/core`'s `finding-round`, which is
 * the module that WRITES them. A local copy of either string made this gate and the
 * composer two independent sources of one fact, and one rename apart from silently
 * refusing the host's own elements. */

/**
 * Was this element composed by the HOST's round-history writer, rather than merely
 * labelled `orchestrator` by whoever produced it? The author kind is necessary and not
 * sufficient: it has to be the composer's own id, or an element the host minted into its
 * round-history namespace. A seat that forges `{kind: "orchestrator"}` onto a code_ref it
 * authored fails both halves and stays subject to the patchset test.
 */
function isHostComposedHistory(element: DraftElement): boolean {
  const author = (element.data as { author?: { kind?: unknown; id?: unknown } }).author;
  if (author?.kind !== "orchestrator") return false;
  return author.id === HOST_COMPOSER_AUTHOR_ID || element.id.startsWith(HOST_ROUND_HISTORY_PREFIX);
}

export function admitBoardReferences(board: DraftBoard, patchsetId: string): RefAdmission {
  const byId = new Map(board.elements.map((element) => [element.id, element]));
  const byIdentity = new Map<string, DraftElement[]>();
  for (const element of board.elements) {
    const identity = refIdentity(element.id);
    byIdentity.set(identity, [...(byIdentity.get(identity) ?? []), element]);
  }
  /** Does this element's citation belong to the patchset the board is about? */
  const admissibleTarget = (element: DraftElement): boolean => {
    if (element.kind !== "code_ref") return true;
    const data = element.data as { patchset_id?: unknown };
    return data.patchset_id === patchsetId || isHostComposedHistory(element);
  };

  const repairs: RefRepair[] = [];
  const unrepairable: { elementId: string; field: string; targetId: string }[] = [];
  const elements = mapElementReferences(board.elements, ({ sourceId, field, targetId }) => {
    const exact = byId.get(targetId);
    // Spelled exactly and admissible: the document holds it, so it is written as authored.
    if (exact !== undefined && admissibleTarget(exact)) return undefined;
    const expectedKind = REPAIR_TARGET_KIND[`${byId.get(sourceId)?.kind ?? ""}.${field}`];
    const candidates = (byIdentity.get(refIdentity(targetId)) ?? []).filter(
      (candidate) =>
        candidate.id !== sourceId &&
        (expectedKind === undefined || candidate.kind === expectedKind) &&
        admissibleTarget(candidate),
    );
    const only = candidates.length === 1 ? candidates[0] : undefined;
    if (only === undefined) {
      unrepairable.push({ elementId: sourceId, field, targetId });
      return undefined;
    }
    repairs.push({ elementId: sourceId, field, from: targetId, to: only.id });
    return only.id;
  });

  if (repairs.length === 0) return { board, repairs, unrepairable };
  return { board: { ...(board as object), elements } as DraftBoard, repairs, unrepairable };
}

/**
 * Rewrite schema-declared element references across a set of elements. `resolve` names
 * the replacement target for one reference, or `undefined` to leave it exactly as it is.
 * Element order, kinds and every non-reference field are untouched, and an element with
 * no rewritten reference is returned by identity — so a board with nothing to rewrite is
 * not silently rebuilt.
 *
 * A rewritten `many` field is DEDUPLICATED, first occurrence winning: two entries can
 * resolve to the same target (`["c1", "C_1"]` both meaning `c1`, or two seat findings
 * collapsing into one), and a list naming the same element twice renders it twice.
 */
function mapElementReferences(
  elements: readonly DraftElement[],
  resolve: (reference: ElementReference) => string | undefined,
): DraftElement[] {
  return elements.map((element) => {
    /** field → (current target → replacement). */
    const byField = new Map<string, Map<string, string>>();
    for (const reference of elementReferences(element)) {
      const replacement = resolve(reference);
      if (replacement === undefined) continue;
      const targets = byField.get(reference.field) ?? new Map<string, string>();
      targets.set(reference.targetId, replacement);
      byField.set(reference.field, targets);
    }
    if (byField.size === 0) return element;
    const data: Record<string, unknown> = { ...(element.data as Record<string, unknown>) };
    for (const [field, targets] of byField) {
      const value = data[field];
      if (typeof value === "string") data[field] = targets.get(value) ?? value;
      else if (Array.isArray(value)) {
        const seen = new Set<string>();
        data[field] = value.flatMap((item) => {
          if (typeof item !== "string") return [item];
          const mapped = targets.get(item) ?? item;
          if (seen.has(mapped)) return [];
          seen.add(mapped);
          return [mapped];
        });
      }
    }
    return { ...element, data } as DraftElement;
  });
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
 * against seat A's `c1` after the merge (finding 7). Pure.
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
 * elements then union by id (now collision-free). Pure.
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
  const reconciled = reconcileFindingsWithProvenance(
    aFindings.map((el) => toFindingElement(el, boardA)),
    bFindings.map((el) => toFindingElement(el, boardB)),
    labels,
  );
  const byId = new Map<string, { agreement: FindingAgreement }>(
    reconciled.map(({ finding }) => [finding.findingId, { agreement: finding.agreement }]),
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

  // A collapsed finding leaves its citers (its seat's own section `children`) pointing at
  // an id the merged board no longer contains — a `bad-ref` the board service rejects the
  // whole write for (#548). The reconciler is the one place that KNOWS the intended
  // target, because it did the collapsing, so it hands back which ids each surviving row
  // consumed and they are repointed here. Re-deriving the pairing from anchors would be a
  // second matcher: the real one is greedy, order-sensitive and matches within a line
  // window, so two seats agreeing at slightly different spans would not be recognised.
  const successorOf = new Map<string, string>();
  for (const { finding, superseded } of reconciled) {
    for (const consumed of superseded) successorOf.set(consumed, finding.findingId);
  }

  const placed = new Set<string>();
  const kept: DraftElement[] = [];
  for (const el of boardA.elements) {
    if (el.kind === "finding" && !byId.has(el.id)) continue; // collapsed into seat B's kept partner
    kept.push(el.kind === "finding" ? merged(el) : el);
    placed.add(el.id);
  }
  for (const el of boardB.elements) {
    if (placed.has(el.id)) continue;
    if (el.kind === "finding" && !byId.has(el.id)) continue; // collapsed into seat A's kept partner
    kept.push(el.kind === "finding" ? merged(el) : el);
    placed.add(el.id);
  }
  const elements =
    successorOf.size === 0
      ? kept
      : mapElementReferences(kept, ({ targetId }) => successorOf.get(targetId));

  const document = finalizedFlaggedDocument(boardA.document ?? boardBArg.document, elements);

  return {
    ...(boardA as object),
    ...(document === undefined ? {} : { document }),
    elements,
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
 * reviewed checkout, so the prompt carries identity and derived signals — never
 * the hunk index (D5: a citation is a path and a line range, so the seat needs no
 * hunk ids to copy back) — and the drafter reads the change itself with its own
 * tools. Inlining the whole diff here is what used to blow
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
  round?: RoundDraftContext,
  options?: {
    /**
     * Drop the reviewed-range task layer. The legacy round-report seat verifies
     * the exact TURN diff, and telling it to read the whole branch range would
     * name a second, contradicting range.
     */
    readonly omitTaskLayer?: boolean;
  },
): string {
  // The hunk index never travels: the seat cites by path and line and reads the
  // content from the checkout it is standing in (D5). `JSON.stringify` drops an
  // undefined key, so the context carries no `hunks` at all.
  const context = JSON.stringify({
    deltaPacket: { ...packet, hunks: undefined },
    // On rounds the round-report drafts FIRST and is the lens drafters' input (D3/R58).
    ...(reportBoard === undefined ? {} : { roundReport: reportBoard }),
    ...(designArtifacts === undefined ? {} : { designArtifacts }),
    ...(round === undefined
      ? {}
      : {
          round: {
            number: round.number,
            dispatchedAsks: round.dispatchedAsks,
            // The worker's verbatim turn diff never rides here: the classified
            // round-report path carries a measured evidence manifest (#727), and
            // every drafter gets the worker's identity and shape and reads the
            // content from the checkout like everything else.
            ...(round.worker === undefined
              ? {}
              : {
                  worker: {
                    outcome: round.worker.outcome,
                    changedPaths: round.worker.changedPaths,
                    commitRange: round.worker.commitRange,
                  },
                }),
          },
        }),
  });
  const repo = packet.patchset?.repository;
  // Two capture shapes, two diff commands — and neither lets the prompt claim
  // the working directory IS the reviewed state, because it may not be:
  //  - a working-tree capture pins the reviewed bytes as `reviewedTreeOid`
  //    (`base..head` would omit uncommitted work), and the live tree can move
  //    after capture;
  //  - a range capture (PR / branch) diffs `base...head` (THREE-dot: from the
  //    merge base — an advanced base with two dots invents base-only
  //    deletions), and the checkout may sit on a different ref entirely.
  // Pinned objects are always readable: `git show <oid>:<path>`.
  const diffCommand =
    repo === undefined
      ? "`git diff`"
      : repo.reviewedTreeOid === undefined
        ? `\`git diff ${repo.baseOid}...${repo.headOid}\``
        : `\`git diff ${repo.baseOid} ${repo.reviewedTreeOid}\``;
  const reviewedOid = repo?.reviewedTreeOid ?? repo?.headOid;
  const task = [
    repo === undefined
      ? "Your working directory is a checkout of the reviewed repository."
      : repo.reviewedTreeOid === undefined
        ? `You are reviewing the commits since ${repo.baseOid} (${repo.baseRef}), at reviewed head ${repo.headOid}. Your working directory is a checkout of this repository, but it may be on a different ref — the pinned objects are authoritative.`
        : `You are reviewing the working-tree change since ${repo.baseOid} (${repo.baseRef}), pinned as tree ${repo.reviewedTreeOid} (uncommitted work included). Your working directory is the checkout it was captured from; the pinned tree is authoritative if it has moved.`,
    "The context layer carries the change INVENTORY (file rows and derived signals) — not the diff content.",
    `Read the change yourself with your own tools: ${diffCommand} for the delta${
      reviewedOid === undefined
        ? ""
        : `, \`git show ${reviewedOid}:<path>\` for reviewed file content`
    }, \`git log\`, file reads, grep — and cite only what you actually read.`,
  ].join("\n");
  if (options?.omitTaskLayer === true) {
    return `${renderLayer("payload", promptText)}\n\n${renderLayer("context", context)}`;
  }
  return `${renderLayer("payload", promptText)}\n\n${renderLayer("task", task)}\n\n${renderLayer("context", context)}`;
}

/** What `renderDrafterPrompt` adds around the bundle's own JSON: the key and its comma. */
const DESIGN_ARTIFACTS_KEY_CHARS = ',"designArtifacts":'.length;

/**
 * Fit the design bundle to the room the drafter prompt has left under the T3 seat's
 * input cap. T3 accepts `thread.turn.start` and refuses an input over
 * `T3_TURN_INPUT_MAX_CHARS` afterwards, on the reactor's fiber, where the refusal is an
 * activity and no turn ever starts (drive 1.6, both runs, 2026-09-03: the Design seat's
 * 241,848-character prompt — 103k of hunk inventory plus a 126k bundle — while the five
 * seats without a bundle sat at 110k and ran). Discovery bounds the bundle at 512 KiB,
 * four times the cap, so this is the bound at the interpolation: the same trimming order
 * and the same `omitted*` / `truncated` markers as discovery, with `limits` naming the
 * budget. Everything else in the prompt keeps its size; when THAT alone overflows, no fit
 * can help, and the seat fails fast on the sidecar's own refusal instead.
 *
 * The cap counts characters; the fit counts UTF-8 bytes, which is never fewer.
 */
export function fitDesignArtifactsToPrompt(
  designArtifacts: DesignArtifactSet,
  promptWithoutBundle: string,
  maxChars: number = T3_TURN_INPUT_MAX_CHARS,
): DesignArtifactSet {
  const room = maxChars - promptWithoutBundle.length - DESIGN_ARTIFACTS_KEY_CHARS;
  return fitDesignArtifactsToBytes(designArtifacts, Math.max(0, room));
}

/**
 * The re-draft prompt: the same base plus the failing draft and the
 * ZodError-shaped pointers the validation loop produced. The seat returns a
 * corrected board (the loop freezes passing elements, so only the pointed-at
 * elements need fixing).
 */
/**
 * A lint pointer's path indexes the WHOLE previous draft, so the pointed-at element's id
 * rides beside it (#743 review). A parse pointer (no ruleId) indexes the seat's rejected
 * return, not this draft: no id.
 */
export function elementIdForPointer(
  draft: DraftBoard,
  pointer: { readonly path: readonly (string | number)[]; readonly ruleId?: string },
): string | undefined {
  return pointer.ruleId !== undefined &&
    pointer.path[0] === "elements" &&
    typeof pointer.path[1] === "number"
    ? draft.elements[pointer.path[1]]?.id
    : undefined;
}

export function renderRetryPrompt(
  basePrompt: string,
  draft: DraftBoard,
  pointers: readonly { path: readonly (string | number)[]; message: string; ruleId?: string }[],
  frozenIds: readonly string[] = [],
): string {
  const elementIdAt = (p: (typeof pointers)[number]): string | undefined =>
    elementIdForPointer(draft, p);
  const issues = pointers
    .map((p) => {
      const id = elementIdAt(p);
      const where = id === undefined ? "" : ` (element \`${id}\`)`;
      return `- ${p.ruleId ?? "schema"} at ${JSON.stringify(p.path)}${where}: ${p.message}`;
    })
    .join("\n");
  // The repair is a PATCH (#737): the host keeps every frozen element verbatim
  // (`mergePatch`), so only the elements still open ride here, with the frozen ids
  // listed so references to them stay valid. A repair turn is a fresh cold session
  // (ephemeral sessions cannot be resumed), so the base prompt still travels; the
  // draft it carries no longer re-sends what is already accepted.
  const frozen = new Set(frozenIds);
  const { elements, ...boardRest } = draft;
  const elementsToFix = elements.filter((el) => !frozen.has(el.id));
  // Nothing open and nothing frozen is the re-ask after a non-emission or an
  // unparseable return: there is no patch to make, the seat drafts the whole board.
  // Asking for a patch of nothing invites `{ elements: [] }`, which reads as a clean
  // absence (#743 review).
  if (elementsToFix.length === 0 && frozen.size === 0) {
    const whole = renderLayer(
      "task",
      `Your previous draft did not pass. Fix ONLY these issues and return the whole board:\n${issues}\n\nPrevious draft:\n${JSON.stringify(draft)}`,
    );
    return `${basePrompt}\n\n${whole}`;
  }
  const patchInput = {
    ...boardRest,
    elementsToFix,
    frozenElementIds: [...frozen],
  };
  const prior = renderLayer(
    "task",
    `Your previous draft did not pass. Fix ONLY these issues:\n${issues}\n\nReturn a PATCH board: the elements under \`elementsToFix\` below, corrected, plus any new element you need. Elements in \`frozenElementIds\` are already accepted and are kept verbatim by the host — do not resend them; references to their ids remain valid. Each issue names the element it is about; pointer paths index the previous whole draft's \`elements\`.\n\nPrevious draft (open elements only):\n${JSON.stringify(patchInput)}`,
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

// ── Per-lane, per-attempt retry budgets (#725 D4) ──

/**
 * How many MODEL REPAIR turns one lane may spend, indexed by whole-board attempt
 * (`[first attempt, every repeat]`). A "whole-board attempt" is a fresh drafting run over
 * the same generation — the initial draft, then the re-draft a restart's partial-state
 * recovery starts (#549's retryable failures re-draft; `rounds.ts` calls that path
 * `"partial"`). The repeat entry is DELIBERATELY smaller than the first: a lane that has
 * already had a full ladder and still needs a whole new board must not silently get a
 * refreshed one, because that is how one restart multiplies into an unbounded provider
 * bill.
 *
 * The table is per lane so a lane's cost can be tuned where its cost differs — Flagged
 * runs two seats, so each repair turn there costs two provider calls. The first-attempt
 * numbers below are the ladder that shipped ({@link RETRY_CAP} = 1) stated explicitly
 * rather than inherited, so changing one lane is one edit and not a global re-tune.
 */
export const LENS_RETRY_BUDGET: Readonly<Record<LintTarget, readonly [number, number]>> = {
  report: [1, 1],
  sequence: [1, 1],
  decisions: [1, 1],
  flagged: [1, 1],
  design: [1, 1],
  noise: [1, 1],
};

/**
 * This lane's repair budget for `boardAttempt` (0 = the first whole-board attempt). Every
 * repeat draws the SAME repeat entry — attempt 5 is no richer than attempt 1, which is
 * what bounds a restart: N restarts cost N × (one draft + the repeat budget), never a
 * silently refreshed ladder that grows with each recovery.
 *
 * The repeat entry is a REDUCED budget, never a zero one, and the difference is the whole
 * point. A zero repeat starves the redraft permanently: one malformed output on a repeat
 * attempt terminates that lane, and the restart recovery that exists precisely to re-draft
 * a retryable lens can then never produce a board for it. One repair turn keeps the bound
 * and removes the starve.
 */
export function lensRetryBudget(lens: LintTarget, boardAttempt: number): number {
  const [first, repeat] = LENS_RETRY_BUDGET[lens];
  return boardAttempt <= 0 ? first : repeat;
}

// ── Per-phase timing (#725 D4 / #726 D8) ──

/** What ran a seat — the Council routes per job, so this is read off the resolution, never
 *  assumed from settings (#726 D8). */
export interface SeatProvenance {
  readonly harness?: CouncilHarnessId;
  readonly model?: string;
}

/** One seat's wall-clock span in one phase, with the provenance that produced it. */
export interface SeatSpan extends SeatProvenance {
  readonly from: number;
  readonly to: number;
}

/**
 * Accumulate a lane's provider WALL-CLOCK spans, split into the drafting turn and the
 * repair ladder and kept PER SEAT. Wall clock, not summed turn time: the Flagged lane runs
 * two seats in parallel, and a sum would report a latency no reviewer ever waited.
 *
 * Per seat, because a single aggregate record for the dual lane could name no harness at
 * all — and a stage record with no harness is exactly what makes "was this run dual-model
 * or single-model?" underivable from the stages (#726 D8, which requires deriving it from
 * them rather than from settings). Each seat gets its own record with its own provenance;
 * the LANE's aggregate span stays derivable as min-start/max-end across them.
 */
function createSeatSpans(clock: () => number) {
  const spans = new Map<string, { seat: SeatProvenance; from: number; to: number }>();
  const key = (phase: string, seat: SeatProvenance): string =>
    `${phase}\u0000${seat.harness ?? ""}\u0000${seat.model ?? ""}`;
  const note = (
    phase: "draft" | "repair",
    seat: SeatProvenance,
    from: number,
    to: number,
  ): void => {
    const id = key(phase, seat);
    const held = spans.get(id);
    spans.set(
      id,
      held === undefined
        ? { seat, from, to }
        : { seat: held.seat, from: Math.min(held.from, from), to: Math.max(held.to, to) },
    );
  };
  return {
    /** Wrap a seat so every turn it runs lands in the right phase's span for THAT seat. */
    wrap<T extends (prompt: string, attempt: number) => Promise<HarnessTurnResult>>(
      seat: T,
      provenance: SeatProvenance = {},
    ): T {
      return (async (prompt: string, attempt: number) => {
        const from = clock();
        try {
          return await seat(prompt, attempt);
        } finally {
          note(attempt === 0 ? "draft" : "repair", provenance, from, clock());
        }
      }) as T;
    },
    /** Every seat's span in this phase, in the order the seats first ran. */
    of(phase: "draft" | "repair"): readonly SeatSpan[] {
      return [...spans.entries()]
        .filter(([id]) => id.startsWith(`${phase}\u0000`))
        .map(([, { seat, from, to }]) => ({ ...seat, from, to }));
    },
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
 * A board's document/validation metadata (finding 3). `draftToOps` serializes
 * only a board's ELEMENTS to the whiteboard event log; its document opening and
 * validation results are board-level, live only in memory, and the
 * frozen 13-kind vocabulary has no element to carry them. This is the durable home the
 * composition root supplies (a store keyed by `boardId`), persisted BEFORE a board's
 * arrival is announced so a reader never reconstructs an incomplete board.
 */
export interface BoardMeta {
  readonly lens: LintTarget;
  readonly boardId: string;
  /** Optional only for records reconstructed from before this contract; new writes always set it. */
  readonly document?: BoardDocument;
  readonly blemishes: readonly Violation[];
  readonly omissions: readonly Omission[];
  readonly immutability: readonly Violation[];
  /** The reference repairs the admission pass made before this board was written (#548 D1).
   *  Recorded so a repair is accountable after the fact, never a silent rewrite. */
  readonly refRepairs?: readonly RefRepair[];
}

// ── One lens's outcome ──

/**
 * The typed account beside a lens `failure` (#549): which attempt produced it and
 * whether another attempt could plausibly succeed. `failure` stays the drafter's own
 * words — this classifies them, so the no-board path is distinguishable from a lens
 * that has already spent its ladder without ever parsing.
 *
 * The shape is the protocol's `LensFailureAccount`, not a pipeline-local twin: this
 * account is written durably onto the generation and read back after a restart, so
 * one definition owns the in-run value and the persisted one.
 */
export type { LensFailureAccount };

/** A drafting failure as the internal drafters report it, before it becomes an outcome. */
type LensDraftFailure = {
  readonly failure: string;
  readonly failureAccount?: LensFailureAccount;
};

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
  /** The typed classification of `failure`, when the failing path could name one. */
  readonly failureAccount?: LensFailureAccount;
  /** A successful typed absence: the lens ran and honestly found nothing to render. */
  readonly absence?: LensAbsenceReason;
  /** Reference repairs the admission pass made before this board was written (#548 D1). */
  readonly refRepairs?: readonly RefRepair[];
}

/** A report already durably written under this drafting attempt's reserved identity. */
export interface ReusableRoundReport {
  readonly boardId: string;
  readonly board: DraftBoard;
  readonly omissions: readonly Omission[];
  readonly blemishes: readonly Violation[];
  readonly immutability: readonly Violation[];
}

// ── The scheduler deps (all injected — the runtime is pure over them) ──

export interface LensPipelineDeps {
  /** The Claude harness port, or null when no `claude` resolved. */
  readonly claudePort: HarnessPort | null;
  /** The codex utility executor, or null when no `codex` resolved. */
  readonly codexExecutor: CodexExecutor | null;
  /**
   * The T3 sidecar seam (t3-lens-threads). Present ⇒ every BOARD seat runs as a turn on
   * its own persistent thread for this generation, and a repair is the next turn on that
   * thread. Absent ⇒ the ephemeral Claude/Codex legs, exactly as before.
   */
  readonly t3?: T3SeatSeam;
  /**
   * Why there is no seam (review finding 1). Set by the round runtime when the daemon
   * composed a sidecar and could not bring it up; every board seat then fails with this
   * reason rather than running on an ephemeral leg nobody asked for. Both absent ⇒ a
   * caller with no sidecar at all (every direct-call test), which keeps the old legs.
   */
  readonly t3Unavailable?: string;
  /** Council context override; availability defaults to the resolved ports. */
  readonly council?: CouncilResolveContext;
  /** The PR worktree the drafter sessions are rooted at (D1). */
  readonly repoRoot: string;
  /** The change inventory the drafter prompts carry (the hunk index redacted at render). */
  readonly deltaPacket: DeltaPacket;
  /** Exact generation visit being drafted. Older direct callers fall back to the initial
   *  content-derived generation; the rounds runtime always supplies this. */
  readonly currentGeneration?: string;
  /** Trusted durable-ask identity for a returned round. */
  readonly round?: RoundDraftContext;
  /** Per-lens lint context the caller assembles (changed regions, files, patchsetId…). */
  readonly lintContextFor: (lens: LintTarget) => LintContext;
  /** Undefined keeps the legacy drafter-owned discovery path; null is a successful no-spec result. */
  readonly designArtifacts?: DesignArtifactSet | null;
  /** Pinned discovery failed before drafting. Settles Design only; sibling lenses still run. */
  readonly designArtifactFailure?: string;
  /** Read a prompt file's text (node fs seam; hermetic in tests). */
  readonly readPrompt: PromptReader;
  /**
   * The generation's spend tap (#737). Every provider turn this pipeline runs — board,
   * report, repair, on either harness — records one metric here; the caller sums it
   * onto the generation. Absent, nothing is measured and the round shows no number.
   */
  readonly collector?: MetricsCollector;
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
  /**
   * Which WHOLE-BOARD attempt this generation is on: `0` (or absent) is the first
   * drafting run, `1`+ a re-draft after a restart recovered partial state. It selects the
   * per-lane repair budget ({@link lensRetryBudget}); a repeat attempt draws the reduced
   * ladder, so restart recovery cannot silently refresh a full one every time.
   */
  readonly boardAttempt?: number;
  /** The per-board arrival broadcast (B09 consumes; optional). */
  readonly onBoardArrival?: (event: BoardArrivalEvent) => void | Promise<void>;
  /** One phase's measured duration (#725 D4). The caller owns durability. */
  readonly onPhaseTiming?: (record: GenerationPhaseTiming) => void | Promise<void>;
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
   * The durable home for a board's validation metadata (finding 3): the document
   * opening and validation blemishes the whiteboard event log cannot carry.
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
 *
 * `evidenceJson` is the manifest's MEASURED serialization, spliced in verbatim rather
 * than re-serialized here (#727): the bytes the budget was measured on are then the
 * exact bytes on the wire by construction, not because two call sites happen to agree.
 * It REPLACES the verbatim `worker.diff` that used to ride here uncapped. The worker's
 * own account (paths, commit range) still travels as identity; it was never authority.
 */
export function renderRoundReportClassifierPrompt(
  promptText: string,
  patchsetId: string,
  round: LandedRoundDraftContext,
  evidenceJson: string,
): string {
  // The wrapper is serialized without `evidence`, then its closing brace is replaced by
  // the measured bytes. The wrapper always has keys, so `slice(0, -1)` leaves a valid
  // object prefix and no key can collide with the appended one.
  const wrapper = JSON.stringify({
    patchsetId,
    dispatchedAsks: round.dispatchedAsks.map(({ id, path, instruction, span, side }) => ({
      id,
      path,
      instruction,
      ...(span === undefined ? {} : { span }),
      ...(side === undefined ? {} : { side }),
    })),
    worker: {
      outcome: round.worker.outcome,
      changedPaths: round.worker.changedPaths,
      commitRange: round.worker.commitRange,
    },
  });
  const context = `${wrapper.slice(0, -1)},"evidence":${evidenceJson}}`;
  return `${renderLayer("payload", promptText)}\n\n${renderLayer("context", context)}`;
}

interface ClassifiedRoundOutcome {
  readonly status: "addressed" | "partial" | "untouched" | "beyond";
  readonly ref: string;
  readonly text: string;
  readonly note: string;
  /** The manifest ids this bucket owns. Empty only for `untouched`. */
  readonly evidenceIds: readonly string[];
  /** Host-DERIVED from the first cited text hunk; absent when every cited unit is a
   *  rename, a mode change, or a binary file, which have no line to anchor to. */
  readonly anchor?: RoundEvidenceAnchor;
}

/**
 * The displayed anchor for one bucket: the first cited TEXT HUNK in canonical manifest
 * order, preferring one on the ask's own path. Derived, never model-supplied — the
 * classifier's job is which evidence, not which line.
 */
function deriveAnchor(
  evidenceIds: readonly string[],
  manifest: readonly RoundEvidenceUnit[],
  preferredPath?: string,
): RoundEvidenceAnchor | undefined {
  const cited = new Set(evidenceIds);
  const hunks = manifest.filter(
    (unit): unit is Extract<RoundEvidenceUnit, { kind: "text-hunk" }> =>
      unit.kind === "text-hunk" && cited.has(unit.id),
  );
  const preferred =
    preferredPath === undefined
      ? undefined
      : hunks.find((unit) => unit.path === preferredPath || unit.anchor.path === preferredPath);
  return (preferred ?? hunks[0])?.anchor;
}

function classifiedRoundOutcomes(
  classification: RoundReportClassification,
  asks: readonly ComposableAsk[],
  manifest: readonly RoundEvidenceUnit[],
): ClassifiedRoundOutcome[] {
  if (classification.beyond.length > ROUND_REPORT_MAX_BEYOND_ENTRIES) {
    throw new Error(
      `reports ${classification.beyond.length} beyond-ask entries, over the ${ROUND_REPORT_MAX_BEYOND_ENTRIES}-entry limit`,
    );
  }
  const known = new Set(asks.map((ask) => ask.id));
  const byAsk = new Map<string, RoundReportClassification["outcomes"][number]>();
  for (const outcome of classification.outcomes) {
    if (!known.has(outcome.askId)) {
      throw new Error(`contains unknown dispatched ask ${outcome.askId}`);
    }
    if (byAsk.has(outcome.askId)) {
      throw new Error(`repeats dispatched ask ${outcome.askId}`);
    }
    byAsk.set(outcome.askId, outcome);
  }

  const missing = asks.filter((ask) => !byAsk.has(ask.id)).map((ask) => ask.id);
  if (missing.length > 0) throw new Error(`omitted dispatched asks: ${missing.join(", ")}`);

  // #726 — every manifest id lands in exactly one ask bucket or the beyond bucket,
  // BEFORE anything is built or persisted.
  verifyRoundEvidencePartition(
    [
      ...classification.outcomes.map((outcome) => ({
        bucket: `the outcome for ${outcome.askId}`,
        evidenceIds: outcome.status === "untouched" ? [] : outcome.evidenceIds,
      })),
      ...classification.beyond.map((outcome) => ({
        bucket: `the beyond-ask entry ${outcome.ref}`,
        evidenceIds: outcome.evidenceIds,
      })),
    ],
    manifest,
  );

  const outcomes: ClassifiedRoundOutcome[] = asks.map((ask) => {
    const classified = byAsk.get(ask.id);
    if (classified === undefined) throw new Error(`omitted dispatched ask ${ask.id}`);
    if (classified.status === "untouched") {
      return {
        status: classified.status,
        ref: ask.id,
        text: ask.instruction,
        note: classified.note,
        evidenceIds: [],
      };
    }
    const anchor = deriveAnchor(classified.evidenceIds, manifest, ask.path);
    return {
      status: classified.status,
      ref: ask.id,
      text: ask.instruction,
      note: classified.note,
      evidenceIds: classified.evidenceIds,
      ...(anchor === undefined ? {} : { anchor }),
    };
  });
  outcomes.sort(
    (left, right) =>
      CLASSIFIED_ROUND_REPORT_STATUS_ORDER.indexOf(left.status) -
      CLASSIFIED_ROUND_REPORT_STATUS_ORDER.indexOf(right.status),
  );
  const beyond: ClassifiedRoundOutcome[] = classification.beyond
    .map((outcome) => {
      const anchor = deriveAnchor(outcome.evidenceIds, manifest);
      return {
        status: "beyond" as const,
        ref: outcome.ref,
        text: outcome.text,
        note: outcome.note,
        evidenceIds: outcome.evidenceIds,
        ...(anchor === undefined ? {} : { anchor }),
      };
    })
    .sort((left, right) => compareByCodeUnit(left.ref, right.ref));
  return [...outcomes, ...beyond];
}

function buildClassifiedRoundReport(
  classification: RoundReportClassification,
  round: LandedRoundDraftContext,
  patchsetId: string,
  manifest: readonly RoundEvidenceUnit[],
): DraftBoard {
  const outcomes = classifiedRoundOutcomes(classification, round.dispatchedAsks, manifest);
  const elements: DraftElement[] = [];
  const outcomeIds: string[] = [];
  for (const [index, outcome] of outcomes.entries()) {
    const outcomeId = `rennet:host:round-report:${index}:outcome`;
    const codeRefId = `rennet:host:round-report:${index}:code`;
    outcomeIds.push(outcomeId);
    if (outcome.anchor !== undefined) {
      elements.push({
        id: codeRefId,
        kind: "code_ref",
        data: {
          author: CLASSIFIED_ROUND_REPORT_AUTHOR,
          patchset_id: patchsetId,
          path: outcome.anchor.path,
          side: outcome.anchor.side,
          start_line: outcome.anchor.line,
          end_line: outcome.anchor.line,
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
        ...(outcome.evidenceIds.length === 0 ? {} : { evidence_ids: [...outcome.evidenceIds] }),
        ...(outcome.anchor === undefined ? {} : { code_ref: codeRefId }),
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
  } as DraftBoard;
}

export interface LensPipelineResult {
  readonly boards: readonly LensBoardOutcome[];
  /** The Flagged board's reattachment/detachment facts, when this was a round. */
  readonly findingResolutions?: readonly FindingResolution[];
  /**
   * The round-report board, present only on a ROUND (a prior generation exists).
   * It drafts FIRST and is the lens drafters' input (D3/R58); it is NOT a lens.
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
  seat: BoardSeatId,
  deps: LensPipelineDeps,
  council: CouncilResolveContext,
  outputSchema: unknown = boardOutputSchema(),
): ((prompt: string, attempt: number) => Promise<HarnessTurnResult>) | { failure: string } {
  const resolved = resolveBoardSeatDetails(jobId, seat, deps, council, outputSchema);
  return "failure" in resolved ? { failure: resolved.failure } : resolved.runTurn;
}

/**
 * One seat of one generation. Board jobs route to the T3 leg when the daemon composed a
 * sidecar seam ({@link LensPipelineDeps.t3}), so the seat runs as a persistent thread and
 * a repair is the next turn on it. A daemon that HAS a sidecar and could not bring it up
 * passes {@link LensPipelineDeps.t3Unavailable} instead, and every board seat fails with
 * that reason. Neither present ⇒ a direct-call caller with no sidecar behind it, which
 * keeps the ephemeral legs.
 */
function resolveBoardSeatDetails(
  jobId: CouncilJobId,
  seat: BoardSeatId,
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
      ...(deps.t3 === undefined ? {} : { t3: { seat, seam: deps.t3 } }),
      ...(deps.t3Unavailable === undefined ? {} : { t3Unavailable: deps.t3Unavailable }),
      repoRoot: deps.repoRoot,
      label: `board.${jobId}`,
      ...(deps.collector === undefined ? {} : { collector: deps.collector }),
      // The classifier's raw response cap rides the session spec, so the adapter
      // rejects an oversized response at the transport boundary — core only ever
      // sees decoded values, so a core-side check would already be too late. The
      // token cap rides beside it and reaches only the Claude leg, which is the only
      // transport with a knob for it; the byte cap is the backstop on both.
      ...(jobId === "round-report"
        ? {
            outputByteCap: ROUND_REPORT_OUTPUT_MAX_BYTES,
            outputTokenCap: ROUND_REPORT_OUTPUT_MAX_TOKENS,
          }
        : {}),
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

/**
 * The lenses whose admissible absence is NOT provable by an empty board. Design admits
 * `no-material`, but only a grounded dismissal of its candidate set proves it — an empty
 * Design board is a drafting failure, so the design row of the protocol table is
 * deliberately absent from {@link EMPTY_LENS_ABSENCE} below.
 */
const EMPTY_BOARD_PROVES_NO_ABSENCE: ReadonlySet<LensKind> = new Set(["design"]);

/**
 * The absence a parsed, zero-element board settles as, per lens — DERIVED from the
 * protocol's `LENS_ADMISSIBLE_ABSENCES` rather than restating its rows (#549 finding d).
 * A lens that admits exactly one absence gets it; a lens that admits none (Sequence)
 * gets none, so an empty Sequence board stays a failure; Design is excluded above.
 * Adding an absence to a lens in the protocol table therefore cannot leave this map
 * silently disagreeing with it.
 */
const EMPTY_LENS_ABSENCE: Partial<Record<LensKind, LensAbsenceReason>> = Object.fromEntries(
  LENS_KINDS.flatMap((lens) => {
    if (EMPTY_BOARD_PROVES_NO_ABSENCE.has(lens)) return [];
    const admissible = LENS_ADMISSIBLE_ABSENCES[lens];
    // More than one admissible absence would make "which one does empty mean?" a real
    // question this map cannot answer; none means the lens has no clean empty settlement.
    return admissible.length === 1 && admissible[0] !== undefined ? [[lens, admissible[0]]] : [];
  }),
);

/** A lens that settled with nothing but a failure — the drafter's words and its account. */
function failedLensOutcome(lens: LintTarget, failure: LensDraftFailure): LensBoardOutcome {
  return { lens, omissions: [], blemishes: [], immutability: [], ...failure };
}

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

/** Extras a caller hands the drafting ladder without disturbing its positional shape. */
interface DraftLensOptions {
  /** The seat's turns run on ONE persistent thread (the T3 leg), so a repair is a
   *  follow-up turn and carries pointers only, never the base prompt again. */
  readonly sameThread?: boolean;
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
  retryCap: number,
  transformOutput?: (output: unknown) => unknown,
  options?: DraftLensOptions,
): Promise<DraftedLens | LensDraftFailure>;
function draftOneLens(
  basePrompt: string,
  seatTurn: (prompt: string, attempt: number) => Promise<HarnessTurnResult>,
  ctx: LintContext,
  retryCap: number,
  transformOutput: (output: unknown) => unknown,
  initialAbsence: (output: unknown) => { readonly absence: "no-material" } | undefined,
  options?: DraftLensOptions,
): Promise<DraftedLens | LensDraftFailure | { readonly absence: "no-material" }>;
async function draftOneLens(
  basePrompt: string,
  seatTurn: (prompt: string, attempt: number) => Promise<HarnessTurnResult>,
  ctx: LintContext,
  retryCap: number,
  transformOutput: (output: unknown) => unknown = (output) => output,
  initialAbsenceOrOptions?:
    | ((output: unknown) => { readonly absence: "no-material" } | undefined)
    | DraftLensOptions,
  maybeOptions?: DraftLensOptions,
): Promise<DraftedLens | LensDraftFailure | { readonly absence: "no-material" }> {
  const initialAbsence =
    typeof initialAbsenceOrOptions === "function" ? initialAbsenceOrOptions : undefined;
  const options =
    maybeOptions ??
    (typeof initialAbsenceOrOptions === "object" ? initialAbsenceOrOptions : undefined);
  // The seat's turns run on ONE persistent thread, so the base prompt and the failing
  // draft are already in the conversation and a repair carries only its pointers.
  const sameThread = options?.sameThread === true;
  const who = ctx.lens === "report" ? "round-report seat" : `${ctx.lens} lens`;
  try {
    const first = await seatTurn(basePrompt, 0);
    // #549 — a first turn that emitted NOTHING is retryable, and here that classification
    // does the retrying: the non-emission seeds the lint ladder exactly as an unparseable
    // first return already does, so the seat is re-asked instead of the lane settling at
    // attempt 0. `validateDraft` cannot coerce `undefined` into a board, so its parse
    // issues become the retry pointers and the ladder runs. Only a ladder that never
    // parses settles a failure, and that one is terminal because the retries are spent.
    const emitted = first.status === "emitted";
    const noEmission = emitted ? undefined : `${first.status}: ${first.message}`;
    const absence = emitted ? initialAbsence?.(first.body) : undefined;
    if (absence !== undefined) return absence;
    const transformedFirst = emitted ? transformOutput(first.body) : undefined;
    // The seat's OWN empty-board claim, which is what authorizes a clean absence. A turn
    // that emitted nothing made no such claim, so the first EMITTED return decides it —
    // whether that was turn 0 or the re-ask that followed a non-emission.
    let firstEmittedWasEmpty: boolean | undefined = emitted
      ? isTrulyEmptyDraft(transformedFirst)
      : undefined;
    // Whether ANY turn emitted. A ladder in which none did still ends with a parseable
    // board — the retry channel keeps the current (empty) draft on a turn failure — so
    // `everParsed` alone would report "produced zero elements in the emitted board"
    // about a board no seat ever emitted.
    let anyEmitted = emitted;
    let retryAbsence: { readonly absence: "no-material" } | undefined;
    let validated: Awaited<ReturnType<typeof validateDraft>>;
    try {
      validated = await validateDraft(transformedFirst, ctx, {
        // The lane's budget for THIS whole-board attempt (#725 7.5). A repeat attempt
        // draws a reduced ladder, so the seat is never handed a refreshed full one.
        retryCap,
        runTurn: async (req) => {
          try {
            const retry = await seatTurn(
              // t3-lens-threads 1.5 — a repair is the NEXT TURN on the seat's own thread,
              // which already holds the base prompt and the draft. Only the pointers, the
              // frozen ids and the instruction travel. On the ephemeral legs (no sidecar
              // seam) the base prompt still has to ride, because a cold session has no
              // memory of the draft it is being asked to fix.
              sameThread
                ? renderRepairTurn(
                    req.pointers.map((pointer) => ({
                      ...pointer,
                      ...(elementIdForPointer(req.draft, pointer) === undefined
                        ? {}
                        : { elementId: elementIdForPointer(req.draft, pointer) as string }),
                    })),
                    req.frozenIds,
                  )
                : renderRetryPrompt(basePrompt, req.draft, req.pointers, req.frozenIds),
              req.attempt,
            );
            if (retry.status === "emitted") {
              retryAbsence = initialAbsence?.(retry.body);
              if (retryAbsence !== undefined) throw new GroundedDesignAbsenceSignal();
              anyEmitted = true;
              firstEmittedWasEmpty ??= isTrulyEmptyDraft(transformOutput(retry.body));
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
    if (!anyEmitted) {
      // TERMINAL: the seat never emitted, initial turn or re-ask, and the ladder is spent.
      return {
        failure: `${who}: the initial drafting turn did not emit a board (${noEmission}) and no re-ask emitted one across ${validated.attempts} attempts — recorded as a failure, not an empty board.`,
        failureAccount: { attempt: validated.attempts, classification: "terminal" },
      };
    }
    if (!validated.everParsed) {
      // TERMINAL: the ladder is already spent — these ARE the retries.
      return {
        // Name the BUDGET, not just the count. "across 0 attempts" read as a contradiction
        // — it says a ladder was spent and that none was — when the real fact is that this
        // attempt was allotted that many repair turns and used them.
        failure: `${who}: no parseable board (${validated.attempts} of ${retryCap} budgeted repair turn${retryCap === 1 ? "" : "s"} spent) — recorded as a failure, not an empty board.`,
        failureAccount: { attempt: validated.attempts, classification: "terminal" },
      };
    }
    return { ...validated, initialOutputWasEmpty: firstEmittedWasEmpty ?? false };
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
 * silent success. On acceptance the board's validation metadata is durably
 * stored (finding 3) BEFORE the caller announces arrival, so a reconstructed result
 * never sees an announced board whose blemishes were lost.
 */
async function persistBoard(
  deps: LensPipelineDeps,
  lens: LintTarget,
  boardId: string,
  board: DraftBoard,
  validated: ValidatedLike,
  actor: string,
): Promise<
  | { ok: true; board: DraftBoard; repairs: readonly RefRepair[] }
  | { ok: false; reason: string; failureAccount?: LensFailureAccount }
> {
  // #548 D1 — admit every reference against THIS document before the write. An
  // unrepairable one settles the lane as a typed retryable failure naming the exact
  // element and field; it never drops the element to get the rest of the board accepted.
  const admitted = admitBoardReferences(board, deps.deltaPacket.patchset.id);
  if (admitted.unrepairable.length > 0) {
    const cited = admitted.unrepairable
      .map(({ elementId, field, targetId }) => `\`${elementId}.${field}\` → \`${targetId}\``)
      .join(", ");
    return {
      ok: false,
      reason: `${lens} board cites ${admitted.unrepairable.length === 1 ? "a reference" : "references"} this board does not contain and no unique target is provable for (${cited}) — recorded as a failure rather than dropping the element to make the board acceptable.`,
      // RETRYABLE: the seat produced material that cannot be written as authored, which
      // is exactly what another drafting attempt addresses.
      failureAccount: { attempt: validated.attempts ?? 0, classification: "retryable" },
    };
  }
  const admittedBoard = admitted.board;
  const result = await deps.whiteboard.apply(boardId, draftToOps(admittedBoard), actor);
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
    document: resolveBoardDocument(lens, admittedBoard.document),
    blemishes: validated.blemishes,
    omissions: validated.omissions,
    immutability: validated.immutability,
    ...(admitted.repairs.length === 0 ? {} : { refRepairs: admitted.repairs }),
  });
  return { ok: true, board: admittedBoard, repairs: admitted.repairs };
}

/**
 * Run the lens drafting pipeline for one generation. Seeds the five lens drafters,
 * validates + writes each board, and PUBLISHES EACH LANE'S SETTLEMENT THE MOMENT IT LANDS
 * (#725 D4) — there is no global barrier over the five lanes and no cross-lens coverage
 * gate. A required report is the one sequencing boundary: it must exist
 * before fanout (#728). Individual lens failures remain recorded outcomes rather than
 * throws.
 *
 * `Promise.allSettled` still gathers the run for BOOKKEEPING — the returned outcome array,
 * the composition write-through — because those
 * are the run's completion, not its reveal. The settlement publications happen inside the
 * lanes, before that gather ever resolves.
 */
export async function runLensPipeline(deps: LensPipelineDeps): Promise<LensPipelineResult> {
  const clock = deps.now ?? Date.now;
  const record = async (timing: GenerationPhaseTiming): Promise<void> => {
    await deps.onPhaseTiming?.(timing);
  };
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
  const reportFrom = clock();
  const report = reportRequired ? await runRoundReport(deps, council) : undefined;
  // The report phase is measured on its own, whether it produced a board or died: a
  // classifier failure routes to the durable round-failure path and its time still
  // belongs to `report` — a phase that only records its successes hides its slow half.
  if (reportRequired) {
    await record({
      phase: "report",
      startedAtMs: reportFrom,
      durationMs: Math.max(0, clock() - reportFrom),
    });
  }
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
  const revealFrom = clock();
  /** The last moment a lane actually revealed something — an arrival or a typed absence.
   *  A failure settles the lane without revealing anything, so it does not extend the
   *  window this record is named after. */
  let lastRevealAt: number | undefined;

  // Each lens owns a distinct seat, board id, and metadata record, so the five drafts can
  // run independently once the report gate settles. Settlement publication is the one
  // cumulative persistence seam: serialize absences AND arrivals on ONE tail so their
  // durable writes land in settlement order, and keep the tail alive after a rejected
  // callback so one failed save cannot suppress a later settlement. Serialized is not
  // barriered — a lane publishes as soon as the tail reaches it, never after a sibling
  // lane's SEAT finishes.
  let settlementTail = Promise.resolve();
  const publish = (settle: () => void | Promise<void>): Promise<void> => {
    const published = settlementTail.then(settle);
    settlementTail = published.then(
      () => undefined,
      () => undefined,
    );
    return published;
  };
  const settledOutcomes = await Promise.allSettled(
    LENS_KINDS.map(async (lens) => {
      const outcome = await runLensBoard(lens, deps, council, reportBoard);
      if (outcome.absence !== undefined) {
        await publish(() => deps.onLensAbsence?.(lens, outcome.absence as LensAbsenceReason));
        lastRevealAt = clock();
      }
      // #725 D4 — the lane's settlement is published HERE, the moment this board is
      // written and its metadata is durable. Nothing waits for a sibling lane.
      if (outcome.board !== undefined && outcome.boardId !== undefined) {
        const board = outcome.board;
        const boardId = outcome.boardId;
        await publish(() =>
          deps.onBoardArrival?.({
            lens,
            boardId,
            elementCount: board.elements.length,
            // C15 3.3: the carried signal rides the arrival so the live lane label is the
            // SAME `stampDeltas` fact the section markers render — not a re-derivation.
            carried: isCarriedForward(deps.previous?.get(lens), board),
          }),
        );
        lastRevealAt = clock();
      }
      return outcome;
    }),
  );
  // The `reveal` phase is recorded BEFORE the rejection check below, and its clock stops at
  // the last lane that actually REVEALED something. Both halves are honesty fixes:
  //
  //  • A lane that FAILED revealed nothing, so closing the window on it would make this
  //    record measure the fan-out rather than the reveal — the label would name one thing
  //    and measure another. It closes on the last published arrival or absence instead.
  //  • The record used to sit after the `outcomes` map, which THROWS on a rejected lane.
  //    An infrastructure failure therefore lost the timing for the window it most needed
  //    explaining. It is written first now, so a run that dies still reports its reveal.
  await record({
    phase: "reveal",
    startedAtMs: revealFrom,
    durationMs: Math.max(0, (lastRevealAt ?? revealFrom) - revealFrom),
  });
  const rejected = settledOutcomes.find((result) => result.status === "rejected");
  if (rejected !== undefined) throw rejected.reason;
  // Wait for every launched lane before propagating an unexpected infrastructure error.
  // This is the run's COMPLETION bookkeeping, not its reveal — every settlement above has
  // already been published. Array order remains LENS_KINDS even when persistence completed
  // in another order.
  const outcomes = settledOutcomes.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });

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
  // The manifest is measured BEFORE any seat exists, so an overflow costs zero
  // provider calls (#727). It is never truncated, split, or summarized to fit.
  const manifest = buildRoundEvidenceManifest(round.worker.diff);
  const measured = measureRoundEvidenceManifest(manifest);
  if (!measured.ok) {
    return {
      lens: "report",
      omissions: [],
      blemishes: [],
      immutability: [],
      failure: `round-report seat: ${measured.reason} — classification was not attempted.`,
    };
  }
  const seat = resolveBoardSeatDetails(
    "round-report",
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
  const prompt = renderRoundReportClassifierPrompt(
    promptText,
    deps.deltaPacket.patchset.id,
    round,
    measured.json,
  );
  const turnStarted = roundReportTurnStartedMilestone(seat, elapsedMs());
  if (turnStarted !== undefined) emitDiagnostic(turnStarted);
  let turn: HarnessTurnResult;
  // The classification turn measured on its own (#731 9.4), on the WALL clock the phase
  // records share — `now` above may be `performance.now`, which is an origin-relative
  // reading and not comparable with any other phase's start. Emitted from a `finally`,
  // so a turn that threw or refused to emit still reports how long it took to fail and
  // still names the harness that failed it.
  const wall = deps.now ?? Date.now;
  const turnFrom = Math.floor(wall());
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
  } finally {
    await deps.onPhaseTiming?.({
      phase: "report-classification",
      startedAtMs: turnFrom,
      durationMs: Math.max(0, Math.floor(wall()) - turnFrom),
      harness: seat.harness,
      model: seat.model,
    });
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
    board = buildClassifiedRoundReport(parsed.data, round, deps.deltaPacket.patchset.id, manifest);
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
      ...(persisted.failureAccount === undefined
        ? {}
        : { failureAccount: persisted.failureAccount }),
    };
  }
  emitDiagnostic({ stage: "persisted", elapsedMs: elapsedMs() });
  // The WRITTEN board, not the pre-admission draft: a repaired reference must reach the
  // arrival count, the returned outcome and the durable meta as it was actually written.
  const written = persisted.board;
  await deps.onBoardArrival?.({
    lens: "report",
    boardId,
    elementCount: written.elements.length,
    carried: isCarriedForward(deps.previous?.get("report"), written),
  });
  return {
    lens: "report",
    boardId,
    board: written,
    omissions: [],
    blemishes: validated.blemishes,
    immutability: [],
  };
}

/** Legacy callers without an exact worker receipt keep the old generic board path. */
/**
 * What the legacy (no-receipt) report seat needs beyond `report.md`: it is bound to the
 * full board schema, not the narrow envelope, so the prompt's "emit no board structure"
 * rule does not apply to it. Appended on THIS path only — on the live classified path
 * every byte of it would ride every session and every retry for nothing (#740 review).
 */
const LEGACY_ROUND_REPORT_NOTE = [
  "## Legacy compatibility",
  "",
  "This caller supplies no evidence manifest and binds you to the full board schema.",
  "On that shape, express the same verified classifications as `round_outcome` elements",
  "(each with an element `id`, an `author`, and the `ask` it answers; a `code_ref`",
  "element where the context layer's inventory grounds one), under one small document",
  "and one section. The context layer carries the change inventory; there is no diff",
  "command on this path.",
].join("\n");

async function runLegacyRoundReport(
  deps: LensPipelineDeps,
  council: CouncilResolveContext,
): Promise<LensBoardOutcome | undefined> {
  const seat = resolveBoardSeat("round-report", "round-report", deps, council);
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
    `${promptText}\n\n${LEGACY_ROUND_REPORT_NOTE}`,
    deps.deltaPacket,
    undefined,
    undefined,
    deps.round,
    // The reviewed-range task line would name a second, contradicting range
    // for a report seat.
    { omitTaskLayer: true },
  );
  const ctx = deps.lintContextFor("report");
  const validated = await draftOneLens(
    basePrompt,
    seat,
    ctx,
    lensRetryBudget("report", deps.boardAttempt ?? 0),
    undefined,
    { sameThread: deps.t3 !== undefined },
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
      ...(persisted.failureAccount === undefined
        ? {}
        : { failureAccount: persisted.failureAccount }),
    };
  }
  const written = persisted.board;
  await deps.onBoardArrival?.({
    lens: "report",
    boardId,
    elementCount: written.elements.length,
    carried: isCarriedForward(deps.previous?.get("report"), written),
  });

  return {
    lens: "report",
    boardId,
    board: written,
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
  /** Model repair turns spent on this board; absent for boards that ran no lint ladder. */
  readonly attempts?: number;
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
 * trace goes with it. (The host mapping turn that used to fill these is gone with the
 * coverage gate, D5; the Design respec decides what the seat may claim itself.)
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

/**
 * Aggregate the per-seat failure accounts of a multi-seat lens into the lens's one account
 * (#549 finding b). RETRYABLE IFF ANY SEAT IS RETRYABLE: the lens needs one seat to
 * produce a board, so one seat with attempts left is a lens with attempts left, and
 * calling the pair terminal would spend a retry the lens still has. The reported
 * `attempt` belongs to the seat that decided the classification — the first retryable
 * one, otherwise the seat that spent the most attempts before settling terminal.
 * Undefined when no seat named an account (a resolution failure, which has no attempt).
 */
export function aggregateFailureAccount(
  seats: readonly LensDraftFailure[],
): LensFailureAccount | undefined {
  const accounts = seats.flatMap((seat) => (seat.failureAccount ? [seat.failureAccount] : []));
  const retryable = accounts.find(({ classification }) => classification === "retryable");
  if (retryable !== undefined) return retryable;
  return accounts.reduce<LensFailureAccount | undefined>(
    (worst, account) => (worst === undefined || account.attempt > worst.attempt ? account : worst),
    undefined,
  );
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
  retryCap: number,
  wrapSeat: <T extends (prompt: string, attempt: number) => Promise<HarnessTurnResult>>(
    seat: T,
    provenance?: SeatProvenance,
  ) => T,
): Promise<DraftedLens | LensDraftFailure> {
  // `resolveBoardSeatDetails`, not `resolveBoardSeat`: the DETAILS carry the harness and
  // model the Council actually routed to, and every timing record this lane emits names
  // the seat that produced it (#726 D8) — including the single-seat degrade, which ran
  // exactly one resolved seat and can say which.
  const claudeSeat = deps.claudePort
    ? resolveBoardSeatDetails(
        "lens-draft-flagged",
        "flagged-claude",
        deps,
        { availability: { installed: ["claude-code"] } },
        boardOutputSchema(),
      )
    : { failure: "no claude harness" };
  const codexSeat = deps.codexExecutor
    ? resolveBoardSeatDetails(
        "lens-draft-flagged",
        "flagged-codex",
        deps,
        { availability: { installed: ["codex"] } },
        boardOutputSchema(),
      )
    : { failure: "no codex harness" };

  const haveClaude = !("failure" in claudeSeat);
  const haveCodex = !("failure" in codexSeat);
  if (!haveClaude && !haveCodex) {
    // Both reasons, not just the shape: a sidecar that would not start is why BOTH seats
    // are unrunnable, and a lane that only says "no runnable seat" sends the reviewer
    // looking for a missing harness that is sitting right there.
    return {
      failure:
        `lens-draft-flagged resolved to no runnable seat ` +
        `(${claudeSeat.failure}; ${codexSeat.failure})`,
    };
  }

  // Single-seat degrade — honest single-model concurrence, and an honestly ATTRIBUTED
  // timing: one seat ran, so the record names it rather than leaving the stage anonymous.
  if (!haveClaude || !haveCodex) {
    const resolved = haveClaude
      ? (claudeSeat as Exclude<typeof claudeSeat, { failure: string }>)
      : (codexSeat as Exclude<typeof codexSeat, { failure: string }>);
    const label = haveClaude ? DEFAULT_SEAT_LABELS["claude-code"] : DEFAULT_SEAT_LABELS.codex;
    const single = await draftOneLens(
      basePrompt,
      wrapSeat(resolved.runTurn, { harness: resolved.harness, model: resolved.model }),
      ctx,
      retryCap,
      undefined,
      { sameThread: deps.t3 !== undefined },
    );
    // Carry the account, not just the words: the sole seat's classification IS the lens's.
    if ("failure" in single) return single;
    return { ...single, board: stampSingleSeatConcurrence(single.board, label) };
  }

  // Both seats run independently; reconcile their findings (Claude is seat A).
  const claude = claudeSeat as Exclude<typeof claudeSeat, { failure: string }>;
  const codex = codexSeat as Exclude<typeof codexSeat, { failure: string }>;
  const [a, b] = await Promise.all([
    draftOneLens(
      basePrompt,
      wrapSeat(claude.runTurn, { harness: claude.harness, model: claude.model }),
      ctx,
      retryCap,
      undefined,
      { sameThread: deps.t3 !== undefined },
    ),
    draftOneLens(
      basePrompt,
      wrapSeat(codex.runTurn, { harness: codex.harness, model: codex.model }),
      ctx,
      retryCap,
      undefined,
      { sameThread: deps.t3 !== undefined },
    ),
  ]);
  const aOk = !("failure" in a);
  const bOk = !("failure" in b);
  // Neither seat produced a board ⇒ the flagged lens honestly failed.
  if (!aOk && !bOk) {
    const seats = [a as LensDraftFailure, b as LensDraftFailure];
    const account = aggregateFailureAccount(seats);
    return {
      failure: `both flagged seats failed — ${seats[0]?.failure} | ${seats[1]?.failure}`,
      ...(account === undefined ? {} : { failureAccount: account }),
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

/**
 * Run one lane and record its per-phase timings (#725 D4) — `lens-draft` (the drafting
 * turn), `lens-repair` (the repair ladder) and `lens-post-process` (everything
 * deterministic between the ladder and the accepted write). The records are emitted from a
 * `finally`, so a lane that FAILED still reports how long it took to fail; a phase that
 * only measures its successes reports the fast half of the truth.
 */
async function runLensBoard(
  lens: LensKind,
  deps: LensPipelineDeps,
  council: CouncilResolveContext,
  reportBoard?: DraftBoard,
): Promise<LensBoardOutcome> {
  const clock = deps.now ?? Date.now;
  const spans = createSeatSpans(clock);
  let postProcessFrom: number | undefined;
  try {
    return await draftLensBoard(
      lens,
      deps,
      council,
      spans,
      () => {
        postProcessFrom = clock();
      },
      reportBoard,
    );
  } finally {
    const emit = deps.onPhaseTiming;
    if (emit !== undefined) {
      // ONE record PER SEAT (#726 D8). A genuinely dual Flagged lane emits two `lens-draft`
      // records, each naming the harness and model that produced it, so "dual-model" is
      // derivable from the stages rather than assumed. The LANE's span is min-start /
      // max-end across them, which is exactly what a single merged record used to carry —
      // minus the provenance it could not name.
      for (const draft of spans.of("draft")) {
        await emit({
          phase: "lens-draft",
          lens,
          startedAtMs: draft.from,
          durationMs: Math.max(0, draft.to - draft.from),
          ...(draft.harness === undefined ? {} : { harness: draft.harness }),
          ...(draft.model === undefined ? {} : { model: draft.model }),
        });
      }
      for (const repair of spans.of("repair")) {
        await emit({
          phase: "lens-repair",
          lens,
          startedAtMs: repair.from,
          durationMs: Math.max(0, repair.to - repair.from),
          ...(repair.harness === undefined ? {} : { harness: repair.harness }),
          ...(repair.model === undefined ? {} : { model: repair.model }),
        });
      }
      // Absent only when the lane never reached its post-process (a seat that failed to
      // resolve, or a drafting ladder that produced nothing) — honestly no phase to time.
      if (postProcessFrom !== undefined) {
        await emit({
          phase: "lens-post-process",
          lens,
          startedAtMs: postProcessFrom,
          durationMs: Math.max(0, clock() - postProcessFrom),
        });
      }
    }
  }
}

async function draftLensBoard(
  lens: LensKind,
  lensDeps: LensPipelineDeps,
  council: CouncilResolveContext,
  spans: ReturnType<typeof createSeatSpans>,
  markPostProcess: () => void,
  reportBoard?: DraftBoard,
): Promise<LensBoardOutcome> {
  if (lens === "design" && lensDeps.designArtifactFailure !== undefined) {
    return {
      lens,
      omissions: [],
      blemishes: [],
      immutability: [],
      failure: lensDeps.designArtifactFailure,
    };
  }
  if (lens === "design" && lensDeps.designArtifacts === null) {
    return {
      lens,
      omissions: [],
      blemishes: [],
      immutability: [],
      absence: "no-material",
    };
  }
  const promptText = expandPromptPartials(
    await lensDeps.readPrompt(LENS_PROMPT_FILES[lens]),
    await lensDeps.readPrompt(INVESTIGATE_PARTIAL_FILE),
  );
  // The bundle the seat is shown is the bundle everything downstream reasons about — the
  // lint context, the coverage projection, the grounding — so it is fitted once, here, to
  // the room this prompt has under the seat's input cap, and `deps` carries the fitted set
  // from this point on.
  const deps: LensPipelineDeps =
    lens === "design" && lensDeps.designArtifacts != null
      ? {
          ...lensDeps,
          designArtifacts: fitDesignArtifactsToPrompt(
            lensDeps.designArtifacts,
            renderDrafterPrompt(
              promptText,
              lensDeps.deltaPacket,
              reportBoard,
              undefined,
              lensDeps.round,
            ),
          ),
        }
      : lensDeps;
  const semanticDesignAbsence =
    lens === "design" && deps.designArtifacts !== undefined && deps.designArtifacts !== null;
  const basePrompt = renderDrafterPrompt(
    promptText,
    deps.deltaPacket,
    reportBoard,
    lens === "design" ? (deps.designArtifacts ?? undefined) : undefined,
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

  // #725 D4 — this lane's repair budget for this whole-board attempt.
  const retryCap = lensRetryBudget(lens, deps.boardAttempt ?? 0);

  let validated: DraftedLens;
  if (lens === "flagged") {
    // The flagged lens is the dual seat (Claude + Codex, cross-model concurrence).
    const dual = await runFlaggedDual(deps, basePrompt, ctx, retryCap, spans.wrap);
    if ("failure" in dual) {
      return failedLensOutcome(lens, dual);
    }
    validated = dual;
  } else {
    const jobId: CouncilJobId = lens === "noise" ? "lens-draft-noise" : "lens-draft";
    const resolved = resolveBoardSeatDetails(
      jobId,
      lens,
      deps,
      council,
      semanticDesignAbsence ? designDraftOutputSchema() : boardOutputSchema(),
    );
    if ("failure" in resolved) {
      return failedLensOutcome(lens, resolved);
    }
    const seat = spans.wrap(resolved.runTurn, {
      harness: resolved.harness,
      model: resolved.model,
    });
    const drafted =
      semanticDesignAbsence && deps.designArtifacts !== undefined && deps.designArtifacts !== null
        ? await draftOneLens(
            basePrompt,
            seat,
            ctx,
            retryCap,
            transformDesignOutput,
            (output) => groundedDesignAbsence(output, deps.designArtifacts as DesignArtifactSet),
            { sameThread: deps.t3 !== undefined },
          )
        : await draftOneLens(
            basePrompt,
            seat,
            ctx,
            retryCap,
            lens === "design" ? transformDesignOutput : undefined,
            { sameThread: deps.t3 !== undefined },
          );
    if ("failure" in drafted) {
      return failedLensOutcome(lens, drafted);
    }
    if ("absence" in drafted) {
      return { lens, omissions: [], blemishes: [], immutability: [], absence: drafted.absence };
    }
    validated = drafted;
  }
  // Everything from here to the accepted write is the lane's deterministic post-process:
  // grounding, round composition, delta stamping, ref admission and the board write.
  markPostProcess();

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
    const grounded = stripDraftedDesignCoverage(validated.board) as DraftBoard;
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
  // failure, never announced as arrived. On acceptance the coverage/validation metadata is
  // durably stored (finding 3). Arrival is emitted by the lane in `runLensPipeline` the
  // moment this returns — no sibling lane and no cross-lens coverage stands in between.
  const persisted = await persistBoard(deps, lens, boardId, stamped, validated, `lens:${lens}`);
  if (!persisted.ok) {
    return {
      lens,
      omissions: validated.omissions,
      blemishes: validated.blemishes,
      immutability: validated.immutability,
      failure: persisted.reason,
      ...(persisted.failureAccount === undefined
        ? {}
        : { failureAccount: persisted.failureAccount }),
    };
  }

  return {
    lens,
    boardId,
    // The admitted board — what the board service actually holds for this lens.
    board: persisted.board,
    omissions: validated.omissions,
    blemishes: validated.blemishes,
    immutability: validated.immutability,
    ...(persisted.repairs.length === 0 ? {} : { refRepairs: persisted.repairs }),
    ...(findingResolutions === undefined ? {} : { findingResolutions }),
  };
}
