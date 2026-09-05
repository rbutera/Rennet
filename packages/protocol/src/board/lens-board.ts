import { z } from "zod";
import { LENS_KINDS, type LensKind } from "../manifests";
import {
  type BoardDocument,
  BoardDocumentSchema,
  HostElementSchema,
  SectionDeltaSchema,
} from "./schema";

/**
 * `LensBoard` — the projection shape one lens board is served as (client asset
 * risk 1, #489: the shape exists nowhere else and the client must not invent
 * it). B3 freezes the shape; the command that returns it is B4/B10's business.
 *
 * A projection, so it deliberately denormalizes for rendering: the fold line of
 * a section (gist + domain counts + delta badge) is carried on the section entry so a
 * folded section renders without walking the element tree. The tree itself
 * stays the single 13-kind vocabulary — `elements` validates against the very
 * `HostElementSchema` union from `schema.ts`, never a re-model, so the
 * projection's vocabulary drifts with drift test 1, not independently.
 */

/** The lens this board belongs to (id vocabulary from `manifests/`). */
export const LensKindSchema = z.enum(LENS_KINDS);

/** Reader-facing count labels emitted by the board projection. */
export const DOMAIN_COUNT_KINDS = [
  "findings",
  "decisions",
  "requirements",
  "steps",
  "outcomes",
  "groups",
  "files",
  "comments",
] as const;
export const DomainCountKindSchema = z.enum(DOMAIN_COUNT_KINDS);
export type DomainCountKind = z.infer<typeof DomainCountKindSchema>;

type BoardDocumentTarget = LensKind | "report";

const FALLBACK_BOARD_DOCUMENTS = {
  design: { title: "Design", introMarkdown: "", measure: "structured" },
  sequence: { title: "Sequence", introMarkdown: "", measure: "reading" },
  decisions: { title: "Decisions", introMarkdown: "", measure: "reading" },
  flagged: { title: "Flagged", introMarkdown: "", measure: "reading" },
  noise: { title: "Noise", introMarkdown: "", measure: "reading" },
  report: { title: "Round report", introMarkdown: "", measure: "reading" },
} satisfies Record<BoardDocumentTarget, BoardDocument>;

/** Complete a legacy draft/meta record without inventing review prose. */
export function fallbackBoardDocument(target: BoardDocumentTarget): BoardDocument {
  return { ...FALLBACK_BOARD_DOCUMENTS[target] };
}

/** Preserve authored prose while enforcing the reading measure owned by the target. */
export function resolveBoardDocument(
  target: BoardDocumentTarget,
  authored?: BoardDocument,
): BoardDocument {
  const fallback = fallbackBoardDocument(target);
  return authored === undefined ? fallback : { ...authored, measure: fallback.measure };
}

/**
 * One top-level section entry, in reading order — the fold grammar
 * (`lens-pipeline.md`): folded, a section is its one-line `gist` with `counts`
 * (per-kind tallies of what it holds); unfolded, it is the referenced `section`
 * element's children. New projections emit reader-facing domain counts while
 * legacy raw host-kind keys remain readable. `ref` is that section element's id. Fold STATE is
 * UI-only (#462) and not here.
 */
export const LensSectionSchema = z.looseObject({
  ref: z.string().min(1),
  /** The one-line folded summary; it summarizes, never teases. */
  gist: z.string(),
  /** Domain counts shown on the folded line, e.g. `{ findings: 3 }`. */
  // The string key remains open for legacy raw HostKind records. New projections
  // emit only DomainCountKind labels.
  counts: z.record(z.string(), z.number().int().nonnegative()),
  /** R58 round-delta badge, projected from the section element's stamp. */
  delta: SectionDeltaSchema.optional(),
});

/** The lens board projection. Board-level extras pass through (B4 may append). */
export const LensBoardSchema = z.looseObject({
  lens: LensKindSchema,
  /** The generation this board belongs to (append-then-freeze, session/). */
  generation: z.string().min(1),
  boardId: z.string().min(1),
  /** Required on every served board, including boards reconstructed from legacy metadata. */
  document: BoardDocumentSchema,
  /** Top-level sections in reading order, each carrying its fold line. */
  sections: z.array(LensSectionSchema),
  /** The element tree, in the 13-kind host vocabulary, stable element ids. */
  elements: z.array(HostElementSchema),
  /**
   * Set when the persisted board carried round-delta marks minted before marks keyed on
   * citations (session-bound-workspace D5). Those marks keyed on element ids and would be
   * wrong under the current basis, so the projection shows none rather than wrong ones,
   * and says so here.
   */
  marksStripped: z.literal("pre-citation-basis").optional(),
});

/**
 * The report board embedded in a rounds-ledger read. Reports share the host element
 * vocabulary with lens boards, but they are not one of the five review lenses and never
 * contain human-authored review comments.
 */
export const RoundReportBoardSchema = LensBoardSchema.extend({
  lens: z.literal("report"),
}).superRefine((board, context) => {
  board.elements.forEach((element, index) => {
    if (element.kind === "review_comment") {
      context.addIssue({
        code: "custom",
        path: ["elements", index, "kind"],
        message: "round reports cannot contain review comments",
      });
    }
  });
});

export type LensSection = z.infer<typeof LensSectionSchema>;
export type LensBoard = z.infer<typeof LensBoardSchema>;
export type RoundReportBoard = z.infer<typeof RoundReportBoardSchema>;

/** The first board visit over a patchset. A review with no landed round has no durable
 * ledger row yet, so both ends derive this initial address directly from the content id. */
export function generationIdForPatchset(patchsetId: string): string {
  return `gen:${patchsetId}`;
}

/**
 * The immutable board visit produced by one exact dispatched round.
 *
 * Patchsets are content-addressed: P0 → P1 → P0 legitimately revisits the same patchset.
 * A generation is visit-addressed, so a later P0 must not reopen the initial P0 generation
 * or treat its settled report as evidence for the new round. The durable dispatch id is
 * stable across crash/restart and unique to the exact staged-ask occurrences; pairing it
 * with the successor patchset makes the generation deterministic without conflating visits.
 */
export function generationIdForDispatch(patchsetId: string, dispatchId: string): string {
  return `gen:${patchsetId}:dispatch:${dispatchId}`;
}

// ── The fold-line projection, shared by the two readers of a board ───────────
//
// A board's sections are DERIVED from its elements: the top-level `section` elements, in
// the order the ops created them, each tallying its own resolved children. Two callers
// need that derivation and must not disagree about it — the daemon projecting the
// PERSISTED board for `board.read`, and the client folding the LIVE element stream for a
// board being written (`lens-board-tools` D11/D13). A board that read one way while it was
// being written and another way once it settled would reorganise itself under the reviewer
// at the moment the lane settled, which is the one thing "nothing navigates when a lane
// settles" forbids.
//
// Pure and structural: the caller supplies elements as `{ id, kind, data }`, which both the
// board service's projected state and a `DraftElement` already are.

/** One element as either reader holds it, before it is validated as a `HostElement`. */
export interface BoardStateElement {
  readonly id: string;
  readonly kind: string;
  readonly data: Record<string, unknown>;
}

const DOMAIN_COUNT_ENTRIES = [
  ["finding", "findings"],
  ["decision", "decisions"],
  ["requirement", "requirements"],
  ["order_step", "steps"],
  ["round_outcome", "outcomes"],
  ["noise_verdict", "groups"],
  ["code_ref", "files"],
  ["review_comment", "comments"],
] as const satisfies readonly (readonly [string, DomainCountKind])[];

const DOMAIN_COUNT_FOR_HOST_KIND = new Map<string, DomainCountKind>(DOMAIN_COUNT_ENTRIES);

const asBoardString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** The element ids some element names as a child — the nested set, excluded from the
 *  top-level fold lines. Only `children` is a containment relation; other element-typed
 *  attributes (a finding's `code`, a decision's `evidence`) are citations, not nesting. */
function nestedBoardIds(elements: readonly BoardStateElement[]): ReadonlySet<string> {
  const nested = new Set<string>();
  for (const element of elements) {
    const children = element.data.children;
    if (!Array.isArray(children)) continue;
    for (const child of children) if (typeof child === "string") nested.add(child);
  }
  return nested;
}

/**
 * The top-level section entries of a board, in reading order, each with its fold line.
 * `gist` falls back to the section's own TITLE when the drafter authored none — its own
 * words, never a summary this projection wrote.
 */
export function projectBoardSections(elements: readonly BoardStateElement[]): LensSection[] {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const nested = nestedBoardIds(elements);
  return elements
    .filter((element) => element.kind === "section" && !nested.has(element.id))
    .map((element) => {
      const children = Array.isArray(element.data.children) ? element.data.children : [];
      const counts: Record<string, number> = {};
      // A file is counted once however many spans cite it, so a section citing four ranges
      // of one file reads "1 file" rather than four.
      const countedFilePaths = new Set<string>();
      for (const child of children) {
        const childElement = typeof child === "string" ? byId.get(child) : undefined;
        const hostKind = childElement?.kind;
        const domainKind =
          hostKind === undefined ? undefined : DOMAIN_COUNT_FOR_HOST_KIND.get(hostKind);
        if (domainKind === undefined) continue;
        if (domainKind === "files") {
          const path = asBoardString(childElement?.data.path);
          if (path === undefined || countedFilePaths.has(path)) continue;
          countedFilePaths.add(path);
        }
        counts[domainKind] = (counts[domainKind] ?? 0) + 1;
      }
      const delta = element.data.delta;
      return {
        ref: element.id,
        gist: asBoardString(element.data.gist) ?? asBoardString(element.data.title) ?? "",
        counts,
        ...(delta === "new" || delta === "reworked" ? { delta } : {}),
      };
    });
}
