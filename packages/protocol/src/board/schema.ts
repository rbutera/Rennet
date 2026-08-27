import { type AuthoredSchema, compileToWire, defineSchema, WireSchema } from "@wboard/core";
import { z } from "zod";
import type { FindingSeverity } from "../domain";

/**
 * The #462 host board schema — the one schema Rennet declares at board creation
 * (per #455/#456), authored here on `@wboard/core`'s host-schema authoring kit
 * and compiled to the locked wire shape.
 *
 * Two honest layers, per the kit's own doctrine ("authoring is convenience, the
 * wire is truth"):
 *
 * - {@link AUTHORED_BOARD_SCHEMA} — the 13 kinds declared on the kit's typed
 *   authoring surface. Attribute types are the #455 wire set
 *   (`string | number | boolean | element | json`); enums travel the wire as
 *   validated strings, structured actors/anchors travel as `json`. This is what
 *   {@link compileToWire} lowers to the protocol truth.
 * - {@link HostBoardSchema} — the Rennet-side Zod that layers the real vocabulary
 *   (severity/status/coverage/… enums, the nested `concurrence`/`quote`/`ask`
 *   shapes) on top of that topology. This is what parses a board.
 *
 * The two cannot silently drift: `schema.test.ts`'s drift test 2 compiles the
 * authored schema through the kit and re-validates every fixture element's data
 * against the kit's own per-kind validator, so a change to any attribute's wire
 * type breaks the gate.
 *
 * Model rules of record (#462): closed palette — no `custom` kind; no
 * protocol-level relations — every reference is an `element`-typed attribute (an
 * element id); `code_ref` cites the immutable patchset, code is never copied;
 * read-state / attention is UI-only and out of the schema; undeclared `data`
 * fields pass through.
 */

// ─── Shared value vocabularies (enums travel the wire as validated strings) ──

/**
 * A finding's severity. Reuses the shipped `FindingSeverity` scale verbatim
 * (`packages/protocol/src/domain.ts`) — the `satisfies` guard makes an
 * out-of-vocabulary value (a fork) a compile error.
 */
export const SEVERITY_LEVELS = [
  "high",
  "medium",
  "low",
] as const satisfies readonly FindingSeverity[];
const severitySchema = z.enum(SEVERITY_LEVELS);

const authorKindSchema = z.enum(["human", "lens-agent", "orchestrator"]);
/** The shared envelope on every kind: a structured actor (subsumes origin/lens). */
export const AuthorSchema = z.object({
  kind: authorKindSchema,
  id: z.string().min(1),
});

/** A per-model concurrence tally on a finding. */
const concurrenceSchema = z.object({
  model: z.string().min(1),
  agree: z.number().int().nonnegative(),
  total: z.number().int().positive(),
});

/**
 * A prose selection anchor (#462 R27/R28 ripple): the sub-element quote a
 * message/thread replies to. The UI highlight is a projection of this — derived
 * state, never stored presentation.
 */
const quoteAnchorSchema = z.object({
  target: z.string().min(1),
  quote: z.string(),
  offsetHint: z.number().int().nonnegative().optional(),
});

/** A round-outcome's ask reference + its display text (#486 R57 ripple). */
const askRefSchema = z.object({
  ref: z.string().min(1),
  text: z.string(),
});

// ─── Per-kind `data` schemas (the Rennet vocabulary layer) ───────────────────
//
// `data` is a looseObject everywhere: undeclared fields pass through, matching
// wire validation. An `element`-typed attribute's value is another element's id
// (a plain string); `many` makes it a string[]. Enums are validated here; the
// wire only sees strings.

const withAuthor = <S extends z.ZodRawShape>(shape: S) =>
  z.looseObject({ author: AuthorSchema, ...shape });

/** Tier A — lens outputs (typed domain kinds). */
const findingData = withAuthor({
  severity: severitySchema,
  concern: z.string(),
  code: z.array(z.string()).optional(),
  concurrence: z.array(concurrenceSchema).optional(),
  status: z.enum(["open", "addressed", "dismissed"]),
});
const decisionData = withAuthor({
  statement: z.string(),
  evidence: z.array(z.string()).optional(),
  alternatives: z.array(z.string()).optional(),
  why: z.string(),
});
const requirementData = withAuthor({
  shall: z.string(),
  coverage: z.enum(["met", "gap", "partial"]),
  trace: z.array(z.string()).optional(),
});
const noiseVerdictData = withAuthor({
  hunk: z.string(),
  verdict: z.enum(["noise", "signal"]),
  reason: z.string(),
  judge: z.enum(["llm", "deterministic"]),
});
const orderStepData = withAuthor({
  title: z.string(),
  span: z.string(),
  children: z.array(z.string()).optional(),
});
const roundOutcomeData = withAuthor({
  status: z.enum(["addressed", "partial", "untouched", "beyond"]),
  ask: askRefSchema,
  note: z.string(),
  code_ref: z.string().optional(),
});

/** Tier B — the authoring palette (compose / annotate / augment). */
const sectionData = withAuthor({
  title: z.string(),
  children: z.array(z.string()).optional(),
  // R58 round-delta stamp, set by the composition step at regeneration; absence
  // = carried forward. The viewed set that decays the mark is UI-only.
  delta: z.enum(["new", "reworked"]).optional(),
});
const proseData = withAuthor({ markdown: z.string() });
const calloutData = withAuthor({ variant: z.string(), body: z.string() });
const annotationData = withAuthor({ code_ref: z.string(), body: z.string() });
const messageData = withAuthor({
  role: z.enum(["finding", "question", "discuss", "request-change"]),
  reply_to: z.string().optional(),
  code_ref: z.string().optional(),
  // #462 R27/R28 selection-thread ripple + R29–R34 ask lifecycle. Detached is
  // visible, never dropped.
  quote: quoteAnchorSchema.optional(),
  lifecycle: z.enum(["staged", "dispatched", "addressed", "retired", "detached"]).optional(),
});
const codeRefData = withAuthor({
  patchset_id: z.string().min(1),
  path: z.string().min(1),
  side: z.enum(["base", "head"]),
  start_line: z.number().int().nonnegative(),
  end_line: z.number().int().nonnegative(),
  symbol: z.string().optional(),
});
const reviewCommentData = withAuthor({
  body: z.string(),
  code_ref: z.string(),
  status: z.enum(["draft", "posted"]),
  covers: z.array(z.string()).optional(),
});

// ─── The kind → element-schema table (single source for the unions) ──────────

const element = <K extends string, D extends z.ZodType>(kind: K, data: D) =>
  z.object({ id: z.string().min(1), kind: z.literal(kind), data });

/**
 * Every host kind, keyed by kind id. The two board unions are built from this
 * one table — {@link DRAFT_KIND_SCHEMAS} omits keys from it, so Draft can never
 * hand-drift from Host (drift test 1).
 */
export const HOST_KIND_SCHEMAS = {
  finding: element("finding", findingData),
  decision: element("decision", decisionData),
  requirement: element("requirement", requirementData),
  noise_verdict: element("noise_verdict", noiseVerdictData),
  order_step: element("order_step", orderStepData),
  round_outcome: element("round_outcome", roundOutcomeData),
  section: element("section", sectionData),
  prose: element("prose", proseData),
  callout: element("callout", calloutData),
  annotation: element("annotation", annotationData),
  message: element("message", messageData),
  code_ref: element("code_ref", codeRefData),
  review_comment: element("review_comment", reviewCommentData),
} as const;

export type HostKind = keyof typeof HOST_KIND_SCHEMAS;

/**
 * The curation-side kinds a lens draft never authors — the human / thread
 * family. A lens agent emits typed lens outputs and authoring blocks; human
 * discussion (`message`) and the GitHub-anchored human `review_comment` are
 * added during curation, not drafting. Settled against #462's tiers: everything
 * else (all Tier A + the composable Tier B kinds) is draft-authorable.
 */
export const DRAFT_OMITTED_KINDS = ["message", "review_comment"] as const;
type DraftOmittedKind = (typeof DRAFT_OMITTED_KINDS)[number];
export type DraftKind = Exclude<HostKind, DraftOmittedKind>;

const draftOmitSet: ReadonlySet<string> = new Set(DRAFT_OMITTED_KINDS);
/** DraftBoard's kind table, DERIVED from Host by omit — never hand-written. */
export const DRAFT_KIND_SCHEMAS = Object.fromEntries(
  Object.entries(HOST_KIND_SCHEMAS).filter(([k]) => !draftOmitSet.has(k)),
) as Omit<typeof HOST_KIND_SCHEMAS, DraftOmittedKind>;

const hostElementMembers = Object.values(HOST_KIND_SCHEMAS);
const draftElementMembers = Object.values(DRAFT_KIND_SCHEMAS);

/** One element as validated by its kind. */
export const HostElementSchema = z.discriminatedUnion(
  "kind",
  hostElementMembers as [(typeof hostElementMembers)[number], ...typeof hostElementMembers],
);
/** A draft element — the Host union minus {@link DRAFT_OMITTED_KINDS}. */
export const DraftElementSchema = z.discriminatedUnion(
  "kind",
  draftElementMembers as [(typeof draftElementMembers)[number], ...typeof draftElementMembers],
);

/**
 * A host board: a document of elements (headless-CMS sense). The block tree and
 * every reference live in `element`-typed attributes on the elements, not in a
 * board-level relation table. Board-level extras pass through.
 */
export const HostBoardSchema = z.looseObject({
  elements: z.array(HostElementSchema),
});
/** A draft board — {@link HostBoardSchema} restricted to the draft kinds. */
export const DraftBoardSchema = z.looseObject({
  elements: z.array(DraftElementSchema),
});

export type HostElement = z.infer<typeof HostElementSchema>;
export type DraftElement = z.infer<typeof DraftElementSchema>;
export type HostBoard = z.infer<typeof HostBoardSchema>;
export type DraftBoard = z.infer<typeof DraftBoardSchema>;
export type Author = z.infer<typeof AuthorSchema>;

// ─── The draft seam + lint shapes (B8 consumes these; B3 declares them) ──────

/** The validation seam: parse untrusted input as a draft board. */
export type DraftParseResult =
  | { readonly ok: true; readonly value: DraftBoard }
  | { readonly ok: false; readonly issues: readonly z.core.$ZodIssue[] };

/** Parse `unknown` into a {@link DraftBoard}, or the Zod issues that rejected it. */
export function parseDraft(input: unknown): DraftParseResult {
  const result = DraftBoardSchema.safeParse(input);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, issues: result.error.issues };
}

/** One lint-rule hit against a draft (B8's `lint(draft) => Violation[]`). */
export const ViolationSchema = z.object({
  ruleId: z.string().min(1),
  elementRef: z.string().min(1),
  message: z.string(),
});
export type Violation = z.infer<typeof ViolationSchema>;

/**
 * A {@link Violation} the retry ladder exhausted on — the board ships flagged
 * rather than clean. `attempts` is how many retries were spent before giving up.
 * B8 may append fields; hand-editing the derivation above is not allowed.
 */
export const BlemishSchema = ViolationSchema.extend({
  attempts: z.number().int().nonnegative(),
});
export type Blemish = z.infer<typeof BlemishSchema>;

// ─── The kit authoring layer + compiled wire truth (drift test 2) ────────────

type Attr = AuthoredSchema[string]["attributes"][string];
const a = (type: Attr["type"], required: boolean, description: string, many = false): Attr =>
  many ? { type, required, description, many } : { type, required, description };

const AUTHOR_ATTR = a(
  "json",
  true,
  "Structured actor { kind: human | lens-agent | orchestrator, id } — the shared envelope on every kind.",
);
const authored = (
  description: string,
  attributes: Record<string, Attr>,
): AuthoredSchema[string] => ({
  description,
  attributes: { author: AUTHOR_ATTR, ...attributes },
});

/**
 * The 13 kinds on the kit's authoring surface. Enums → `string`; structured
 * actors/anchors/tallies → `json`; references → `element` (an element id, `many`
 * for a list). Kept in lockstep with the per-kind `data` schemas above by drift
 * test 2 (compile through the kit, revalidate the fixture).
 */
export const AUTHORED_BOARD_SCHEMA = defineSchema({
  finding: authored(
    "A raised review finding: severity, concern, cited code, model concurrence, status.",
    {
      severity: a("string", true, "high | medium | low (the shipped FindingSeverity scale)."),
      concern: a("string", true, "The finding, as markdown."),
      code: a("element", false, "code_ref elements the finding cites.", true),
      concurrence: a("json", false, "Per-model { model, agree, total } tallies.", true),
      status: a("string", true, "open | addressed | dismissed."),
    },
  ),
  decision: authored("A design decision recovered from the change.", {
    statement: a("string", true, "The decision, stated."),
    evidence: a("element", false, "code_ref elements evidencing it.", true),
    alternatives: a("element", false, "Alternative-option elements considered.", true),
    why: a("string", true, "Rationale, as markdown."),
  }),
  requirement: authored("A shall-requirement and its coverage in the change.", {
    shall: a("string", true, "The requirement text."),
    coverage: a("string", true, "met | gap | partial."),
    trace: a("element", false, "code_ref elements tracing coverage.", true),
  }),
  noise_verdict: authored("A per-hunk noise/signal verdict.", {
    hunk: a("element", true, "The code_ref element this verdict is on."),
    verdict: a("string", true, "noise | signal."),
    reason: a("string", true, "Why, as markdown."),
    judge: a("string", true, "llm | deterministic."),
  }),
  order_step: authored("One step in a suggested reading order.", {
    title: a("string", true, "The step title."),
    span: a("element", true, "The code_ref element the step spans."),
    children: a("element", false, "Child elements under the step.", true),
  }),
  round_outcome: authored("One item of a round report (#486): how an ask fared.", {
    status: a("string", true, "addressed | partial | untouched | beyond."),
    ask: a("json", true, "The ask reference + its display text { ref, text }."),
    note: a("string", true, "Outcome note, as markdown."),
    code_ref: a("element", false, "An optional code_ref element."),
  }),
  section: authored("A section of the document: a title and child elements.", {
    title: a("string", true, "The section title."),
    children: a("element", false, "Child elements in the section.", true),
    delta: a("string", false, "new | reworked round-delta stamp; absent = carried."),
  }),
  prose: authored("Freeform markdown — the agent's general expressive surface.", {
    markdown: a("string", true, "The prose, as markdown."),
  }),
  callout: authored("An emphasized aside.", {
    variant: a("string", true, "The callout variant."),
    body: a("string", true, "The body, as markdown."),
  }),
  annotation: authored("A prose annotation anchored to cited code.", {
    code_ref: a("element", true, "The code_ref element annotated."),
    body: a("string", true, "The annotation, as markdown."),
  }),
  message: authored("A conversational message; the ask specialization rides on it.", {
    role: a("string", true, "finding | question | discuss | request-change."),
    reply_to: a("element", false, "The element this replies to."),
    code_ref: a("element", false, "A cited code_ref element."),
    quote: a("json", false, "Prose selection anchor { target, quote, offsetHint? }."),
    lifecycle: a("string", false, "staged | dispatched | addressed | retired | detached."),
  }),
  code_ref: authored("A citation into the captured patchset; code is never copied.", {
    patchset_id: a("string", true, "The captured patchset id."),
    path: a("string", true, "Repo-relative file path."),
    side: a("string", true, "base | head."),
    start_line: a("number", true, "First cited line."),
    end_line: a("number", true, "Last cited line."),
    symbol: a("string", false, "Optional drift-resistant symbol anchor."),
  }),
  review_comment: authored("A human review comment; side=head code_ref is the GitHub anchor.", {
    body: a("string", true, "The comment, as markdown."),
    code_ref: a("element", true, "The anchored code_ref element (side=head)."),
    status: a("string", true, "draft | posted."),
    covers: a("element", false, "Elements this comment covers.", true),
  }),
});

/** The compiled wire truth — what the protocol carries. */
export const BOARD_WIRE_SCHEMA = compileToWire(AUTHORED_BOARD_SCHEMA);

/** Re-exported so the board seam owns the kit's wire-shape validator. */
export { WireSchema };
