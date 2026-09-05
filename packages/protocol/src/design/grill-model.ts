import { z } from "zod";

// ── The Design lens's grill-with-docs specification (mirrors the OpenSpec model) ─
//
// grill-with-docs is the sparse, doc-driven specification format written by Matt
// Pocock's `domain-modeling` companion: architecture decision records under
// `docs/adr/**` (`docs/decisions/**` by convention), a `CONTEXT.md` glossary, and —
// in a multi-context repo — a root `CONTEXT-MAP.md` that names each context and the
// directional relationships between them. Unlike an OpenSpec change, which ships a
// fixed artifact set with a rich requirement/scenario tree, this material is
// intentionally thin: a decision plus its stated why and alternatives, a term plus
// its definition and the words to avoid, a context plus its edges.
//
// The parser (`parseGrillSpec` in `@rennet/core`) emits THIS shape, validated at the
// IPC boundary so the live parse-on-open crosses to the renderer intact. Every node
// carries a `source` (repo-relative path + 1-based line), which is what turns a
// Design-view review affordance into a durable disposition against the real file.
//
// Because the source is sparse, the model represents absence HONESTLY: a decision
// that states no alternatives carries an empty array, never invented content; a term
// with no stated `_Avoid_` carries an empty `avoid`; a single-context repo carries an
// empty `contextMaps`. Nothing here is inferred from the diff — a grill spec says
// only what its documents say.

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

/**
 * One entry from a `CONTEXT-MAP.md` `## Contexts` list: the context's name, the link
 * to its own `CONTEXT.md` when the entry is a Markdown link, and its one-line summary
 * when stated. A lens resolves `href` to that context's glossary.
 */
export const grillContextSchema = z.object({
  name: z.string(),
  href: z.string().optional(),
  summary: z.string().optional(),
  source: grillSourceSchema,
});

/**
 * One directional edge from a `CONTEXT-MAP.md` `## Relationships` list. `direction`
 * is `"->"` for a one-way edge (`Ordering → Fulfillment`) or `"<->"` for a
 * bidirectional one (`Ordering ↔ Billing`); a reversed arrow (`←`/`<-`) is
 * normalised by swapping `from`/`to`. `label` carries any trailing description.
 */
export const grillRelationshipSchema = z.object({
  from: z.string(),
  to: z.string(),
  direction: z.enum(["->", "<->"]),
  label: z.string().optional(),
  source: grillSourceSchema,
});

/**
 * One parsed `CONTEXT-MAP.md` (the multi-context marker): its `## Contexts` entries
 * and `## Relationships` edges. Either list is empty (never absent) when the map
 * states none. A single-context repo has no `CONTEXT-MAP.md` and so contributes no
 * context map at all.
 */
export const grillContextMapSchema = z.object({
  contexts: z.array(grillContextSchema),
  relationships: z.array(grillRelationshipSchema),
  source: grillSourceSchema,
});

/** One grill document read off disk: its repo-relative path and raw markdown. */
const grillRawDocSchema = z.object({ path: z.string(), md: z.string() });

/**
 * The verbatim source text alongside the parsed model (#239): the Spec/Design viewer
 * flips to it one keystroke away, never a re-serialization. Each array holds every
 * document of that kind the reader supplied, in reading order.
 */
export const grillSpecRawSchema = z.object({
  adrs: z.array(grillRawDocSchema),
  contextDocs: z.array(grillRawDocSchema),
  contextMaps: z.array(grillRawDocSchema),
});

/**
 * A whole parsed grill-with-docs specification. Every array is empty (never absent)
 * when the source states nothing of that kind — the sparse-honesty invariant. A spec
 * with only an ADR parses to decisions plus two empty arrays and the verbatim `raw`.
 */
export const grillSpecSchema = z.object({
  decisions: z.array(grillDecisionSchema),
  glossary: z.array(grillGlossaryTermSchema),
  contextMaps: z.array(grillContextMapSchema),
  raw: grillSpecRawSchema,
});

/** Where a reviewable grill node came from (path + 1-based line). */
export type GrillSource = z.infer<typeof grillSourceSchema>;
/** One ADR decision: its statement, stated rationale, and considered alternatives. */
export type GrillDecision = z.infer<typeof grillDecisionSchema>;
/** One `CONTEXT.md` glossary entry: term, definition, and words to avoid. */
export type GrillGlossaryTerm = z.infer<typeof grillGlossaryTermSchema>;
/** One `CONTEXT-MAP.md` `## Contexts` entry: name, link, and summary. */
export type GrillContext = z.infer<typeof grillContextSchema>;
/** One `CONTEXT-MAP.md` `## Relationships` directional edge. */
export type GrillRelationship = z.infer<typeof grillRelationshipSchema>;
/** One parsed `CONTEXT-MAP.md`: its contexts and their relationships. */
export type GrillContextMap = z.infer<typeof grillContextMapSchema>;
/** The verbatim source docs carried alongside the parsed grill model (#239). */
export type GrillSpecRaw = z.infer<typeof grillSpecRawSchema>;
/** A whole parsed grill-with-docs specification (decisions, glossary, context maps). */
export type GrillSpec = z.infer<typeof grillSpecSchema>;
