import { z } from "zod";
import { hunkIdSchema } from "../delta/citations";
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

/**
 * One consciously skipped patchset hunk (`lens-pipeline.md`): left to another
 * lens's lane, with the reason. Coverage is data, not prose — composition
 * checks every hunk lands in some lens's taught-or-skipped set.
 */
export const SkippedHunkSchema = z.looseObject({
  /** The stable patchset hunk id (delta/ owns the id shape). */
  hunk: hunkIdSchema,
  reason: z.string(),
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
  skippedHunks: z.array(SkippedHunkSchema),
});

export type LensSection = z.infer<typeof LensSectionSchema>;
export type SkippedHunk = z.infer<typeof SkippedHunkSchema>;
export type LensBoard = z.infer<typeof LensBoardSchema>;

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
