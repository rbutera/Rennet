import { z } from "zod";

// ── The Design lens's grill-with-docs specification (mirrors the OpenSpec model) ─
//
// grill-with-docs is the sparse, doc-driven specification format: architecture
// decision records under `docs/adr/**` / `docs/decisions/**`, and a `CONTEXT.md`
// carrying a glossary (a Language section) and context-map tables. Unlike an
// OpenSpec change, which ships a fixed artifact set with a rich requirement/scenario
// tree, this material is intentionally thin — a decision plus its stated why and
// alternatives, a term plus its definition and the words to avoid, a table row.
//
// The parser (`parseGrillSpec` in `@rennet/core`) emits THIS shape, validated at the
// IPC boundary so the live parse-on-open crosses to the renderer intact. Every node
// carries a `source` (repo-relative path + 1-based line), which is what turns a
// Design-view review affordance into a durable disposition against the real file.
//
// Because the source is sparse, the model represents absence HONESTLY: a decision
// that states no alternatives carries an empty array, never invented content; a term
// with no stated `_Avoid_` carries an empty `avoid`. Nothing here is inferred from
// the diff — a grill spec says only what its documents say.

/**
 * Where a reviewable grill node came from: its repo-relative file path and 1-based
 * start line. The Design board anchors a durable disposition against this exact
 * path+line, so distinct nodes carry distinct lines rather than colliding.
 */
export const grillSourceSchema = z.object({
  path: z.string(),
  line: z.number(),
});

/**
 * One architecture decision record: the decision statement (the ADR's `#` title),
 * its stated rationale (the prose beneath the title, before the first section), and
 * the alternatives it considered. `rationale` is absent when the ADR states none;
 * `alternatives` is empty (never absent) when it lists none. Both are the source's
 * own words, never a paraphrase.
 */
export const grillDecisionSchema = z.object({
  title: z.string(),
  rationale: z.string().optional(),
  alternatives: z.array(z.string()),
  source: grillSourceSchema,
});

/**
 * One glossary entry from a `CONTEXT.md` Language section: the term, its definition,
 * and the words the project avoids for it (`_Avoid_`). `avoid` is empty (never
 * absent) when the entry states none. `group` is the nearest enclosing Language
 * subsection heading when the glossary is grouped.
 */
export const grillGlossaryTermSchema = z.object({
  term: z.string(),
  definition: z.string(),
  avoid: z.array(z.string()),
  group: z.string().optional(),
  source: grillSourceSchema,
});

/** One context-map table row: its cells in source order (the surface's `source_cells`). */
export const grillContextRowSchema = z.object({
  cells: z.array(z.string()),
  source: grillSourceSchema,
});

/**
 * One context-map table (a tech-stack or architecture table): the heading it sits
 * under (when any), its header cells, and its rows. Empty `rows` never occurs — a
 * table with no body rows is not recorded.
 */
export const grillContextMapSchema = z.object({
  heading: z.string().optional(),
  headers: z.array(z.string()),
  rows: z.array(grillContextRowSchema),
  source: grillSourceSchema,
});

/**
 * A whole parsed grill-with-docs specification. Every array is empty (never absent)
 * when the source states nothing of that kind — the sparse-honesty invariant. A spec
 * with only an ADR parses to decisions plus two empty arrays.
 */
export const grillSpecSchema = z.object({
  decisions: z.array(grillDecisionSchema),
  glossary: z.array(grillGlossaryTermSchema),
  contextMaps: z.array(grillContextMapSchema),
});

/** Where a reviewable grill node came from (path + 1-based line). */
export type GrillSource = z.infer<typeof grillSourceSchema>;
/** One ADR decision: its statement, stated rationale, and considered alternatives. */
export type GrillDecision = z.infer<typeof grillDecisionSchema>;
/** One `CONTEXT.md` glossary entry: term, definition, and words to avoid. */
export type GrillGlossaryTerm = z.infer<typeof grillGlossaryTermSchema>;
/** One context-map table row (its cells in source order). */
export type GrillContextRow = z.infer<typeof grillContextRowSchema>;
/** One context-map table: heading, headers, and rows. */
export type GrillContextMap = z.infer<typeof grillContextMapSchema>;
/** A whole parsed grill-with-docs specification (decisions, glossary, context maps). */
export type GrillSpec = z.infer<typeof grillSpecSchema>;
