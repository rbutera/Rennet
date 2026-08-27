import { z } from "zod";
import { LENS_KINDS } from "../manifests";
import { HostElementSchema, SectionDeltaSchema } from "./schema";

/**
 * `LensBoard` — the projection shape one lens board is served as (client asset
 * risk 1, #489: the shape exists nowhere else and the client must not invent
 * it). B3 freezes the shape; the command that returns it is B4/B10's business.
 *
 * A projection, so it deliberately denormalizes for rendering: the fold line of
 * a section (gist + counts + delta badge) is carried on the section entry so a
 * folded section renders without walking the element tree. The tree itself
 * stays the single 13-kind vocabulary — `elements` validates against the very
 * `HostElementSchema` union from `schema.ts`, never a re-model, so the
 * projection's vocabulary drifts with drift test 1, not independently.
 */

/** The lens this board belongs to (id vocabulary from `manifests/`). */
export const LensKindSchema = z.enum(LENS_KINDS);

/**
 * One top-level section entry, in reading order — the fold grammar
 * (`lens-pipeline.md`): folded, a section is its one-line `gist` with `counts`
 * (per-kind tallies of what it holds); unfolded, it is the referenced `section`
 * element's children. `ref` is that section element's id. Fold STATE is
 * UI-only (#462) and not here.
 */
export const LensSectionSchema = z.looseObject({
  ref: z.string().min(1),
  /** The one-line folded summary; it summarizes, never teases. */
  gist: z.string(),
  /** Per-kind counts shown on the folded line, e.g. `{ finding: 3 }`. */
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
  hunk: z.string().min(1),
  reason: z.string(),
});

/** The lens board projection. Board-level extras pass through (B4 may append). */
export const LensBoardSchema = z.looseObject({
  lens: LensKindSchema,
  /** The generation this board belongs to (append-then-freeze, session/). */
  generation: z.string().min(1),
  boardId: z.string().min(1),
  /** Top-level sections in reading order, each carrying its fold line. */
  sections: z.array(LensSectionSchema),
  /** The element tree, in the 13-kind host vocabulary, stable element ids. */
  elements: z.array(HostElementSchema),
  skippedHunks: z.array(SkippedHunkSchema),
});

export type LensSection = z.infer<typeof LensSectionSchema>;
export type SkippedHunk = z.infer<typeof SkippedHunkSchema>;
export type LensBoard = z.infer<typeof LensBoardSchema>;
