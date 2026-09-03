/**
 * Per-docType body schemas and rules for the decomposition angle (issue #8).
 *
 * The RSP core (#6) validates every document's envelope and walks its opaque
 * body generically. This module extends that gate with the two decomposition
 * document bodies and the semantic rules the DSL plan reserves (§4.1):
 *
 *   V100 totality        — ⋃chunks.hunks ∪ residue == the offered hunk set, exactly
 *   V101 no duplication  — no hunk occurrence placed in two chunks
 *   V103 acyclic order   — edges are a DAG; readingOrder is a topological cover
 *   V104 angle set       — a chunk may only declare sequence/decisions/blast-radius
 *   V105 rationale       — every proposal chunk carries a non-empty rationale
 *   V106 completeness    — chunk ids are unique; every referenced chunk is declared
 *   V108 body shape      — the body has the right structural shape at all (gate)
 *
 * Both decomposition documents are atomic (DOC_TYPE_REGISTRY), so any body error
 * rejects the whole document. Angle membership is deliberately NOT enforced by the
 * shape schema (angles parse as `string[]`) so a bad angle rejects with the precise
 * V104 code rather than a generic shape error.
 */

import { z } from "zod";
import type { OfferedManifest, RspDocType, ValidationError } from "../domain";
import type { AnchorKind } from "./citations";

/**
 * The closed set of angles a chunk may be assigned to. Excludes `noise` (verified
 * only by deterministic checkers) and `spec` (a queue over requirements). The
 * `claims` angle is retired (issue #221; the Decisions lens owns that ground). V104.
 */
export const CHUNK_ASSIGNABLE_ANGLES = ["sequence", "decisions", "blast-radius"] as const;

const EDGE_KINDS = ["enables", "evidenced-by", "contradicts", "duplicates", "refactor-of"] as const;

// ── Structural body shape schemas (V108 gate) ────────────────────────────────

const residueItemSchema = z.object({ hunkId: z.string().min(1), reason: z.string() }).loose();

const skeletonChunkSchema = z
  .object({
    chunkId: z.string().min(1),
    hunkIds: z.array(z.string().min(1)),
    // `angles` are strings here on purpose; membership is V104's job so the
    // rejection carries V104's code, not a generic shape error.
    angles: z.array(z.string()),
  })
  .loose();

const proposalChunkSchema = z
  .object({
    chunkId: z.string().min(1),
    title: z.string(),
    hunkIds: z.array(z.string().min(1)),
    angles: z.array(z.string()),
    // Any string (incl. empty) passes the shape; V105 enforces non-empty so the
    // rejection carries V105's code.
    rationale: z.string(),
  })
  .loose();

const proposalEdgeSchema = z
  .object({ from: z.string().min(1), to: z.string().min(1), kind: z.enum(EDGE_KINDS) })
  .loose();

const skeletonBodySchema = z
  .object({
    chunks: z.array(skeletonChunkSchema),
    readingOrder: z.array(z.string().min(1)),
    residue: z.array(residueItemSchema),
  })
  .loose();

const proposalBodySchema = z
  .object({
    chunks: z.array(proposalChunkSchema),
    edges: z.array(proposalEdgeSchema),
    readingOrder: z.array(z.string().min(1)),
    residue: z.array(residueItemSchema),
  })
  .loose();

/**
 * The `ordering` body (issue #9): a comprehension reading order over chunk ids
 * plus a required rationale. `rationale` is any string here (empty passes the
 * shape); V113 enforces non-empty so the rejection carries V113's code.
 */
const orderingBodySchema = z
  .object({
    readingOrder: z.array(z.string().min(1)),
    rationale: z.string(),
  })
  .loose();

/**
 * The `rollup-narration` body (issue #70): a batch of per-altitude narrated
 * accounts. `oneLine`/`paragraph` are any string here (empty passes the shape);
 * V120/V121 enforce non-empty so the rejection carries the precise code. The
 * entry `anchor` is a canvas-node key (NOT a `rennet:` code anchor), so the
 * generic anchor walk ignores it; node coverage is the runner's floor. The
 * optional `evidence` pairs carry `rennet:` code anchors that the generic quote
 * walk (V006) byte-verifies against the offered manifest.
 */
const narrationEvidenceSchema = z
  .object({ anchor: z.string().min(1), quote: z.string().min(1) })
  .loose();

const narrationEntrySchema = z
  .object({
    altitude: z.enum(["rollup", "group", "cohort"]),
    anchor: z.string().min(1),
    oneLine: z.string(),
    paragraph: z.string(),
    evidence: z.array(narrationEvidenceSchema).optional(),
  })
  .loose();

const rollupNarrationBodySchema = z.object({ narrations: z.array(narrationEntrySchema) }).loose();

/**
 * The `finding` body (issue #32 / #138): the automated review layer's findings —
 * the data the Flagged lens renders. Each finding carries a severity, an `anchor`
 * to exactly one offered hunk (a `rennet:` code anchor the generic V005/V008 walk
 * byte-checks against the offered manifest — an unresolvable or minted anchor is
 * rejected there, not here), the concern text, and an agreement/vote state. The
 * agreement mirrors `FindingAgreement`: `concur` carries the vote counts, or
 * `disagree` carries each model's labelled answer. `summary`/`answer` are any
 * string here (empty passes the shape); V130/V131 enforce the non-emptiness and
 * vote coherence so the rejection carries the precise code. The union projects to
 * a clean `anyOf` for the structured-output constraint.
 *
 * The doctype is `itemwise` with no `itemsPointer`, so the whole body is walked
 * here (V108 shape + the generic anchor walk) exactly like an atomic body — one
 * malformed finding rejects the document and the runner falls to its honest
 * failed state (a finding is a model judgement, so there is no deterministic floor
 * to invent). The finding runner culls ungrounded findings before this gate, so a
 * lone hallucinated anchor never sinks the grounded ones.
 */
const findingSeverityBodySchema = z.enum(["high", "medium", "low"]);

const findingModelAnswerBodySchema = z
  .object({ model: z.string().min(1), answer: z.string() })
  .loose();

/**
 * The cross-harness adjudication chip on a disagree row (issue #41): the three-way
 * verdict + a one-line evidence + the adjudicating seat's honest label. ADDITIVE and
 * OPTIONAL on the disagree arm — a disagree row with no `adjudication` validates
 * exactly as before. `verdict` is the closed three-value vocabulary (shape-enforced),
 * deliberately DISTINCT from the verification verdict so a contested row can never be
 * dropped on any value. `evidence`/`adjudicatedBy` are any string here (the shape
 * passes empty); the field never gates, so no dedicated non-emptiness code is spent.
 */
const findingAdjudicationBodySchema = z
  .object({
    verdict: z.enum(["supported", "contradicted", "insufficient"]),
    evidence: z.string(),
    adjudicatedBy: z.string(),
  })
  .loose();

const findingAgreementBodySchema = z.union([
  z.object({ kind: z.literal("concur"), agree: z.number(), total: z.number() }).loose(),
  z
    .object({
      kind: z.literal("disagree"),
      answers: z.array(findingModelAnswerBodySchema),
      adjudication: findingAdjudicationBodySchema.optional(),
    })
    .loose(),
]);

/**
 * The verification chip (issue #179): the reproduce-or-refute verdict + a one-line
 * evidence string. ADDITIVE and OPTIONAL on a finding — `verdict` is the closed
 * three-value vocabulary (shape-enforced, V108); `evidence` is any string here
 * (empty passes the shape), V132 enforcing non-emptiness so the rejection carries a
 * precise code. A finding with no `verification` validates exactly as before.
 */
const findingVerificationBodySchema = z
  .object({
    verdict: z.enum(["reproduced", "refuted", "inconclusive"]),
    evidence: z.string(),
  })
  .loose();

const findingBodyElementSchema = z
  .object({
    findingId: z.string().min(1),
    anchor: z.string().min(1),
    summary: z.string(),
    severity: findingSeverityBodySchema,
    agreement: findingAgreementBodySchema,
    verification: findingVerificationBodySchema.optional(),
  })
  .loose();

const findingBodySchema = z.object({ findings: z.array(findingBodyElementSchema) }).loose();

/**
 * The per-finding VERIFICATION TURN's structured-output shape (issue #179): NOT an
 * RSP document type (verification is a micro-judgment attached to a finding, never
 * a stored doc), so it lives here as a standalone projected schema rather than in
 * `RSP_DOC_TYPES`. A verify turn covers ONE finding (#268 fix round 2: one finding per
 * turn, so execution attribution is true by construction), emitting an array with a
 * single `{ ref, verdict, evidence }` — `ref` is the reference key the runner fed in
 * ("f1"), echoed back. The runner parses this defensively and a missing/garbled entry
 * falls to an honest `inconclusive` (never a drop).
 */
const findingVerificationTurnItemSchema = z
  .object({
    ref: z.string().min(1),
    verdict: z.enum(["reproduced", "refuted", "inconclusive"]),
    evidence: z.string(),
  })
  .loose();

const findingVerificationTurnBodySchema = z
  .object({ verifications: z.array(findingVerificationTurnItemSchema) })
  .loose();

/**
 * The JSON Schema the per-finding verification TURN is constrained to (issue #179).
 * Projected from the Zod shape with the meta-schema `$schema` stripped for the same
 * reason `bodyJsonSchema` strips it (the `claude` CLI validator cannot resolve the
 * 2020-12 meta-schema ref). This is a standalone export — verification is not an
 * `RspDocType`, so it is not reachable through `bodyJsonSchema`.
 */
export function findingVerificationJsonSchema(): unknown {
  const projected = z.toJSONSchema(findingVerificationTurnBodySchema) as Record<string, unknown>;
  delete projected.$schema;
  return projected;
}

/**
 * The per-row ADJUDICATION TURN's structured-output shape (issue #41). Like the
 * verification turn (#179), adjudication is a micro-judgment attached to a contested
 * finding, never a stored RSP document, so it lives here as a standalone projected
 * schema. A turn covers ONE contested row (so the verdict is unambiguously that row's),
 * emitting an array with a single `{ ref, verdict, evidence }` — `ref` is the reference
 * key the runner fed in ("a1"), echoed back. The verdict vocabulary is DISTINCT from
 * verification (supported/contradicted/insufficient, never reproduced/refuted) so no
 * verdict can carry a drop semantic. The runner parses defensively; a missing/garbled
 * entry falls to an honest `insufficient` (never a drop).
 */
const findingAdjudicationTurnItemSchema = z
  .object({
    ref: z.string().min(1),
    verdict: z.enum(["supported", "contradicted", "insufficient"]),
    evidence: z.string(),
  })
  .loose();

const findingAdjudicationTurnBodySchema = z
  .object({ adjudications: z.array(findingAdjudicationTurnItemSchema) })
  .loose();

/**
 * The JSON Schema the per-row adjudication TURN is constrained to (issue #41).
 * Projected from the Zod shape with the `$schema` meta ref stripped (same reason as
 * `findingVerificationJsonSchema`: the `claude` CLI validator cannot resolve the
 * 2020-12 meta-schema). Standalone — adjudication is not an `RspDocType`.
 */
export function findingAdjudicationJsonSchema(): unknown {
  const projected = z.toJSONSchema(findingAdjudicationTurnBodySchema) as Record<string, unknown>;
  delete projected.$schema;
  return projected;
}

/**
 * The verify-ui TURN's structured-output shape (issue #183). Like verification
 * (#179) and coverage (R53), verify-ui is a DERIVED, display-time judgement — not a
 * stored RSP document — so it lives here as a standalone projected schema. One turn
 * per review mounts the changed UI surface with whatever the project affords,
 * captures screenshots into the review's evidence directory, and reports:
 *   • `mounted`      — true when it rendered the change (tests/storybook/dev-server);
 *                      false when it could only do a labelled STATIC review.
 *   • `method`       — how it mounted (or `none`/`static`), for the honest disclosure.
 *   • `attempted`    — what it tried, so a could-not-mount result carries its account.
 *   • `screenshots`  — `{ path, label }` with `path` RELATIVE to the evidence dir the
 *                      prompt named (the turn writes the PNGs there); empty is honest.
 *   • `observations` — the a11y / intent-mismatch / visual defects it found, each
 *                      anchored to a changed file (with a line when it can name one)
 *                      and an `impact` the runner maps to a finding severity.
 * The runner GROUNDS this itself (a screenshot claim without an observed exec is
 * treated as a static, inconclusive result), so it does not lean on the RSP
 * validator. A malformed emission falls to the honest `unavailable` disclosure —
 * never a fabricated all-clear.
 */
const uiVerificationObservationSchema = z
  .object({
    file: z.string().min(1),
    line: z.number().int().positive().optional(),
    impact: z.enum(["high", "medium", "low"]),
    summary: z.string().min(1),
    evidence: z.string(),
  })
  .loose();

const uiVerificationScreenshotSchema = z
  .object({ path: z.string().min(1), label: z.string() })
  .loose();

const uiVerificationTurnBodySchema = z
  .object({
    mounted: z.boolean(),
    method: z.enum(["tests", "storybook", "dev-server", "static", "none"]),
    attempted: z.string(),
    screenshots: z.array(uiVerificationScreenshotSchema),
    observations: z.array(uiVerificationObservationSchema),
  })
  .loose();

/**
 * The JSON Schema the verify-ui turn is constrained to (issue #183). Projected from
 * the Zod shape with the meta-schema `$schema` stripped for the same reason
 * `bodyJsonSchema` strips it (the `claude` CLI validator cannot resolve the 2020-12
 * meta-schema ref). Standalone — verify-ui is not an `RspDocType`.
 */
export function uiVerificationJsonSchema(): unknown {
  const projected = z.toJSONSchema(uiVerificationTurnBodySchema) as Record<string, unknown>;
  delete projected.$schema;
  return projected;
}

/**
 * The `decision.record` body (issue #137): the Decisions lens's data — the calls
 * the implementer made, discerned from the change's stated intent and its diff.
 * Each decision carries a plain-language `title`, an `anchor` to exactly one
 * offered hunk (a `rennet:` code anchor the generic V005/V008 walk byte-checks
 * against the offered manifest — an unresolvable or minted anchor rejects that
 * ITEM, since `decision.record` is item-wise with `/body/decisions` as its items
 * pointer, so a lone ungrounded decision never sinks the grounded ones), the
 * `evidence` chips it is drawn from (each a `{kind, label, detail}` naming a
 * SOURCE — spec / pr-body / hunk — never a verdict), an optional reconstructed
 * `why`, and the `alternatives` not taken.
 *
 * This schema is the MODEL-FACING structured-output shape only: it names what the
 * agent emits, NOT the on-disk document. Two runner-owned invariants are stamped
 * AFTER the turn and so are deliberately absent here: the `decisionId` (the runner
 * mints identity — agents never mint it), and `why.reconstructed` (the runner
 * stamps the literal `true`, so an inferred rationale can never be presented as a
 * stated fact — reconstructed-ness is structural, not the model's to assert). The
 * model emits `why` as `{ text }`; the runner wraps it to `{ reconstructed: true,
 * text }`.
 *
 * NO TRIAGE TAXONOMY (issue #137, load-bearing): there is deliberately no
 * evidenced / mechanical / contestable field anywhere in this shape. Grouping (the
 * canvas projector's job) + evidence + a reconstructed why is the whole shape;
 * judging a decision is the reviewer's job, not a pre-chewed classification's.
 *
 * NOTE: because `decision.record` is item-wise WITH an items pointer, the protocol
 * validator drives the per-item generic anchor/quote walk and does NOT invoke
 * `validateBodyRules` for it (see `validateDocument`). So this schema is consumed
 * ONLY by `bodyJsonSchema` (the structured-output constraint); it is not a second
 * on-disk gate, and `validateBodyRules` short-circuits it to `[]`.
 */
const decisionEvidenceBodySchema = z
  .object({
    kind: z.enum(["spec", "pr-body", "hunk"]),
    label: z.string(),
    detail: z.string(),
  })
  .loose();

const decisionWhyBodySchema = z.object({ text: z.string() }).loose();

const decisionBodyElementSchema = z
  .object({
    anchor: z.string().min(1),
    title: z.string(),
    evidence: z.array(decisionEvidenceBodySchema),
    why: decisionWhyBodySchema.optional(),
    alternatives: z.array(z.string()),
  })
  .loose();

const decisionRecordBodySchema = z
  .object({ decisions: z.array(decisionBodyElementSchema) })
  .loose();

/**
 * The `noise` body (issue #34): the Noise lens's data — the low-signal churn a
 * changeset touches, grouped away from the code that needs eyes. Each group carries
 * a `category` (the closed churn vocabulary), a plain-speech `summary`, a
 * `judgedBy` chip (a deterministic mechanical `rule` naming the rule, OR the LLM
 * `noise-job`), and the `items` it collects — each an `anchor` to exactly one
 * offered hunk (a `rennet:` code anchor the generic V005/V008 walk byte-checks
 * against the offered manifest; an unresolvable or minted anchor rejects the whole
 * document, so the runner culls ungrounded items before this gate), a plain
 * `detail`, and an optional `deviates` flag (a line that BREAKS its group's pattern
 * and must eject into normal review rather than be suppressed).
 *
 * This is the MODEL-FACING structured-output shape: it names what the agent emits.
 * Two runner-owned fields are stamped AFTER the turn and are deliberately NOT
 * required here (agents never mint identity, and never assert the model label): the
 * per-group `groupId`, and the `model` on a `noise-job` chip (the runner stamps
 * which model ran). The schema is `.loose()` so the ON-DISK document — which carries
 * both stamped fields — also satisfies it when the atomic validator re-checks the
 * body shape (V108); it is not a second gate that would reject the runner's own
 * well-formed output.
 */
const noiseCategoryBodySchema = z.enum([
  "formatting",
  "lockfile",
  "import-order",
  "generated",
  "fixture-rename",
  "comment-typo",
  "other",
]);

const noiseJudgedByBodySchema = z.union([
  z.object({ kind: z.literal("rule"), rule: z.string() }).loose(),
  z.object({ kind: z.literal("noise-job") }).loose(),
]);

const noiseItemBodySchema = z
  .object({
    anchor: z.string().min(1),
    detail: z.string(),
    deviates: z.boolean().optional(),
  })
  .loose();

const noiseGroupBodySchema = z
  .object({
    category: noiseCategoryBodySchema,
    summary: z.string(),
    judgedBy: noiseJudgedByBodySchema,
    items: z.array(noiseItemBodySchema),
  })
  .loose();

const noiseBodySchema = z.object({ groups: z.array(noiseGroupBodySchema) }).loose();

/**
 * The `review.hypothesis` body (issue #178): the committed prior a lens runner
 * disconfirms against. `domain`/`designExpectation` and each risk's
 * `statement`/`disconfirmer` are any string here (empty passes the shape);
 * V150/V152/V154/V155 enforce non-emptiness so the rejection carries the precise
 * code. The risk `severity` reuses the closed finding vocabulary (shape-enforced,
 * V108). `riskId` is stamped by the PASS after the turn (agents never mint
 * identity), so it is deliberately NOT required here — the `.loose()` schema
 * accepts the ON-DISK doc that carries it AND the model emission that does not.
 * The 5-10 risk bound is V153. This is an atomic doc: any error rejects the whole.
 */
const hypothesisRiskBodySchema = z
  .object({
    statement: z.string(),
    severity: findingSeverityBodySchema,
    disconfirmer: z.string(),
  })
  .loose();

const reviewHypothesisBodySchema = z
  .object({
    domain: z.string(),
    scope: z
      .object({
        inScope: z.array(z.string()),
        outOfScope: z.array(z.string()),
      })
      .loose(),
    designExpectation: z.string(),
    risks: z.array(hypothesisRiskBodySchema),
  })
  .loose();

const BODY_SCHEMAS: Readonly<Partial<Record<RspDocType, z.ZodType>>> = {
  "decomposition.skeleton": skeletonBodySchema,
  "decomposition.proposal": proposalBodySchema,
  ordering: orderingBodySchema,
  "rollup-narration": rollupNarrationBodySchema,
  finding: findingBodySchema,
  "decision.record": decisionRecordBodySchema,
  noise: noiseBodySchema,
  "review.hypothesis": reviewHypothesisBodySchema,
};

/**
 * The JSON Schema an agent's structured output is constrained to, projected from
 * the Zod body schema. `null` for a docType with no body schema in this slice.
 * The exact accepted feature subset is the deferred SDK probe; these bodies use
 * only objects, arrays, strings, and one enum, the safe intersection.
 */
export function bodyJsonSchema(docType: RspDocType): unknown | null {
  const schema = BODY_SCHEMAS[docType];
  if (!schema) return null;
  const projected = z.toJSONSchema(schema) as Record<string, unknown>;
  // Zod stamps a `$schema: ".../draft/2020-12/schema"` meta-schema reference into
  // the projection. The `claude` CLI's `--json-schema` validator cannot resolve
  // that meta-schema and rejects the WHOLE schema at session construction ("no
  // schema with key or ref .../2020-12/schema"), so no structured-output turn can
  // run. The field is metadata the constraint does not need — dropping it leaves
  // the shape (type/properties/required/$defs) untouched. This applies to every
  // docType's projection equally; it was the live-turn blocker for #32.
  delete projected.$schema;
  return projected;
}

// ── Typed views over a shape-validated body ──────────────────────────────────

interface ChunkView {
  chunkId: string;
  hunkIds: string[];
  angles: string[];
  rationale?: string;
}

interface DecompositionBodyView {
  chunks: ChunkView[];
  edges: { from: string; to: string }[];
  readingOrder: string[];
  residue: { hunkId: string }[];
}

function viewOf(docType: RspDocType, parsed: unknown): DecompositionBodyView {
  const body = parsed as Record<string, unknown>;
  const chunks = (body.chunks as Record<string, unknown>[]).map((chunk) => ({
    chunkId: chunk.chunkId as string,
    hunkIds: chunk.hunkIds as string[],
    angles: chunk.angles as string[],
    rationale: typeof chunk.rationale === "string" ? chunk.rationale : undefined,
  }));
  const edges =
    docType === "decomposition.proposal" ? (body.edges as { from: string; to: string }[]) : [];
  return {
    chunks,
    edges,
    readingOrder: body.readingOrder as string[],
    residue: body.residue as { hunkId: string }[],
  };
}

// ── The rule catalogue ───────────────────────────────────────────────────────

/** The immutable ids the manifest offers for one occurrence kind. */
function offeredIdsOfKind(manifest: OfferedManifest, kind: AnchorKind): Set<string> {
  return new Set(
    manifest.occurrences.filter((occurrence) => occurrence.kind === kind).map((o) => o.id),
  );
}

/**
 * Validate a document's body against its schema (V108) and its family's semantic
 * rules. The decomposition family (V100/V101/V103/V104/V105/V106) is checked
 * against the offered `hunk` occurrences; the ordering document (#9,
 * V111/V112/V113) against the offered `chunk` occurrences. Returns every error;
 * an empty array means the body is admitted. Returns `[]` for a docType with no
 * per-body validator, so the caller can dispatch unconditionally.
 */
export function validateBodyRules(
  docType: RspDocType,
  body: unknown,
  manifest: OfferedManifest,
): ValidationError[] {
  const schema = BODY_SCHEMAS[docType];
  if (!schema) return [];

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => ({
      code: "V108",
      pointer: `/body${pointerOf(issue.path)}`,
      message: issue.message,
    }));
  }

  // The ordering document (#9) orders the CHUNK set the decomposition declared.
  if (docType === "ordering") {
    return validateOrderingRules(parsed.data, offeredIdsOfKind(manifest, "chunk"));
  }

  // The roll-up narration (#70): only per-entry prose non-emptiness lives here;
  // node coverage/no-minted/altitude consistency is the runner's floor (the
  // validator has no canvas-node set — the manifest offers code occurrences).
  if (docType === "rollup-narration") {
    return validateNarrationRules(parsed.data);
  }

  // The finding family (#32/#138): per-finding non-emptiness + vote coherence.
  // The anchor's resolution against the offered manifest is the generic walk's
  // job (V005/V008), run for every docType alongside this — so a finding that
  // anchors a hunk it was never offered is rejected there, not here.
  if (docType === "finding") {
    return validateFindingRules(parsed.data);
  }

  // The decision family (#137) is item-wise WITH an items pointer, so
  // `validateDocument` drives the per-item generic anchor walk (each decision's
  // top-level `rennet:hunk/<id>` anchor is checked + grounded there) and never
  // routes here. This branch exists only so a direct/refactored caller cannot fall
  // through to the decomposition `viewOf` path (which assumes a `chunks` body and
  // would throw): decisions carry no per-body semantic rules beyond that generic
  // walk, so the honest answer is the empty error set.
  if (docType === "decision.record") return [];

  // The noise family (#34): the only body gate is V108 (the shape parse above)
  // plus the generic anchor walk `validateDocument` runs alongside this — which
  // grounds every group item's `rennet:hunk/<id>` anchor against the offered
  // manifest. There are no further per-body semantic rules (grouping and the
  // deviating-line ejection are the derivation's job, not the validator's), so the
  // honest answer is the empty error set. This branch exists BEFORE the
  // decomposition fallthrough so a noise body is never fed to the `viewOf` path
  // (which assumes a `chunks` body and would throw).
  if (docType === "noise") return [];

  // The hypothesis pass (#178): per-body semantic rules (non-emptiness + the
  // 5-10 risk bound). The body carries no `rennet:` anchors (the risks are
  // expectations, not code locations), so the generic anchor walk finds nothing
  // and this is the whole body gate. This branch is BEFORE the decomposition
  // fallthrough so a hypothesis body is never fed to the `viewOf` path (which
  // assumes a `chunks` body and would throw).
  if (docType === "review.hypothesis") return validateReviewHypothesisRules(parsed.data);

  const offeredHunkIds = offeredIdsOfKind(manifest, "hunk");
  const view = viewOf(docType, parsed.data);
  const errors: ValidationError[] = [];
  const declared = declaredChunkIds(view, errors); // V106 duplicate-id
  checkTotalityAndDuplication(view, offeredHunkIds, errors); // V100, V101
  checkAngles(view, errors); // V104
  if (docType === "decomposition.proposal") checkRationale(view, errors); // V105
  checkCompleteness(view, declared, errors); // V106 dangling refs
  checkReadingOrder(view, declared, errors); // V103
  return errors;
}

// ── The ordering rule catalogue (issue #9) ───────────────────────────────────

/**
 * Validate an `ordering` body against the offered chunk set: V112 (no minted
 * identity — every ordered id was offered), V111 (totality/cover — every offered
 * chunk appears exactly once), V113 (a non-empty rationale is required). All
 * atomic. The order is a flat cover of the chunk set; there is no edge graph
 * here (the dependency constraints live in the decomposition the pass reads
 * through and are enforced there), so this document only asserts the cover.
 */
function validateOrderingRules(
  parsed: unknown,
  offeredChunkIds: ReadonlySet<string>,
): ValidationError[] {
  const body = parsed as { readingOrder: string[]; rationale: string };
  const errors: ValidationError[] = [];

  // V112 — every ordered id is an offered chunk (agents never mint identity).
  body.readingOrder.forEach((id, index) => {
    if (!offeredChunkIds.has(id)) {
      errors.push({
        code: "V112",
        pointer: `/body/readingOrder/${index}`,
        message: `reading order references a chunk not in the offered set (minted identity): ${id}`,
      });
    }
  });

  // V111 — the order is a cover of the offered set: each offered chunk exactly
  // once. A duplicate and a missing chunk both reject, with distinct messages.
  const counts = new Map<string, number>();
  for (const id of body.readingOrder) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const [id, count] of counts) {
    if (count > 1 && offeredChunkIds.has(id)) {
      errors.push({
        code: "V111",
        pointer: "/body/readingOrder",
        message: `chunk is ordered more than once: ${id}`,
      });
    }
  }
  for (const offeredId of offeredChunkIds) {
    if (!counts.has(offeredId)) {
      errors.push({
        code: "V111",
        pointer: "/body/readingOrder",
        message: `offered chunk is missing from the reading order (not totally ordered): ${offeredId}`,
      });
    }
  }

  // V113 — a rationale is required (the "why this order aids comprehension").
  if (body.rationale.trim().length === 0) {
    errors.push({
      code: "V113",
      pointer: "/body/rationale",
      message: "ordering rationale is empty",
    });
  }

  return errors;
}

// ── The narration rule catalogue (issue #70) ─────────────────────────────────

/**
 * Validate a `rollup-narration` body's per-entry prose: V120 (a non-empty
 * one-line account) and V121 (a non-empty paragraph account). Both atomic. The
 * altitude enum is enforced by the shape schema (V108); the code citations, when
 * present, are byte-verified by the generic `{anchor, quote}` walk (V006). Node
 * coverage/no-minted/altitude consistency is NOT here: the validator has no
 * canvas-node set, so the runner enforces it against the live nodes (the ordering
 * pass's own dependency-floor precedent).
 */
function validateNarrationRules(parsed: unknown): ValidationError[] {
  const body = parsed as { narrations: { oneLine: string; paragraph: string }[] };
  const errors: ValidationError[] = [];
  body.narrations.forEach((entry, index) => {
    if (entry.oneLine.trim().length === 0) {
      errors.push({
        code: "V120",
        pointer: `/body/narrations/${index}/oneLine`,
        message: "narration one-line account is empty",
      });
    }
    if (entry.paragraph.trim().length === 0) {
      errors.push({
        code: "V121",
        pointer: `/body/narrations/${index}/paragraph`,
        message: "narration paragraph account is empty",
      });
    }
  });
  return errors;
}

// ── The finding rule catalogue (issue #32 / #138) ────────────────────────────

/**
 * Validate a `finding` body's per-finding semantics: V130 (a non-empty summary —
 * a flag with no words is not a flag) and V131 (a coherent vote — a `concur` may
 * not claim more agreement than its total, and a `disagree` needs at least the
 * two labelled answers a disagreement is made of). All atomic. The severity enum
 * and the structural agreement shape are enforced by the shape schema (V108); the
 * anchor's resolution against the offered manifest is the generic walk's job
 * (V005/V008). This is the gate that can go red on a model that emits a
 * word-less or self-contradicting finding.
 */
function validateFindingRules(parsed: unknown): ValidationError[] {
  const body = parsed as {
    findings: {
      summary: string;
      agreement:
        | { kind: "concur"; agree: number; total: number }
        | { kind: "disagree"; answers: { answer: string }[] };
      verification?: { verdict: string; evidence: string };
    }[];
  };
  const errors: ValidationError[] = [];
  body.findings.forEach((finding, index) => {
    if (finding.summary.trim().length === 0) {
      errors.push({
        code: "V130",
        pointer: `/body/findings/${index}/summary`,
        message: "finding summary is empty",
      });
    }
    // V132 (issue #179): a verification chip, when present, must carry evidence —
    // a verdict with no words is not a verification. The verdict enum is enforced
    // by the shape schema (V108); this is the non-emptiness gate that can go red.
    if (finding.verification && finding.verification.evidence.trim().length === 0) {
      errors.push({
        code: "V132",
        pointer: `/body/findings/${index}/verification/evidence`,
        message: "finding verification evidence is empty",
      });
    }
    const agreement = finding.agreement;
    if (agreement.kind === "concur") {
      if (agreement.total <= 0 || agreement.agree < 0 || agreement.agree > agreement.total) {
        errors.push({
          code: "V131",
          pointer: `/body/findings/${index}/agreement`,
          message: `finding concur vote is incoherent: ${agreement.agree} of ${agreement.total}`,
        });
      }
    } else if (agreement.answers.length < 2) {
      errors.push({
        code: "V131",
        pointer: `/body/findings/${index}/agreement/answers`,
        message: "finding disagreement needs at least two labelled answers",
      });
    }
  });
  return errors;
}

// ── The hypothesis rule catalogue (issue #178) ───────────────────────────────

/** The bound on how many risks a committed hypothesis must carry. Both inclusive. */
export const HYPOTHESIS_RISK_MIN = 5;
export const HYPOTHESIS_RISK_MAX = 10;

/**
 * Validate a `review.hypothesis` body's semantics: V150 (a non-empty domain — a
 * hypothesis with no subject is not a hypothesis), V152 (a non-empty design
 * expectation), V153 (the risk count is within the 5-10 bound — too few is a
 * rubber stamp, too many is noise), V154 (each risk's statement is non-empty),
 * V155 (each risk's disconfirmer is non-empty — a risk with no check cannot
 * disconfirm anything). All atomic. The severity enum and the structural scope
 * shape are enforced by the shape schema (V108). This is the gate that can go red
 * on a model that emits a subject-less hypothesis, a bad risk count, or a
 * word-less risk.
 */
function validateReviewHypothesisRules(parsed: unknown): ValidationError[] {
  const body = parsed as {
    domain: string;
    designExpectation: string;
    risks: { statement: string; disconfirmer: string }[];
  };
  const errors: ValidationError[] = [];

  if (body.domain.trim().length === 0) {
    errors.push({ code: "V150", pointer: "/body/domain", message: "hypothesis domain is empty" });
  }
  if (body.designExpectation.trim().length === 0) {
    errors.push({
      code: "V152",
      pointer: "/body/designExpectation",
      message: "hypothesis design expectation is empty",
    });
  }
  if (body.risks.length < HYPOTHESIS_RISK_MIN || body.risks.length > HYPOTHESIS_RISK_MAX) {
    errors.push({
      code: "V153",
      pointer: "/body/risks",
      message: `hypothesis must carry between ${HYPOTHESIS_RISK_MIN} and ${HYPOTHESIS_RISK_MAX} risks, got ${body.risks.length}`,
    });
  }
  body.risks.forEach((risk, index) => {
    if (risk.statement.trim().length === 0) {
      errors.push({
        code: "V154",
        pointer: `/body/risks/${index}/statement`,
        message: "hypothesis risk statement is empty",
      });
    }
    if (risk.disconfirmer.trim().length === 0) {
      errors.push({
        code: "V155",
        pointer: `/body/risks/${index}/disconfirmer`,
        message: "hypothesis risk disconfirmer is empty",
      });
    }
  });

  return errors;
}

/** Declared chunk ids (order-preserving), flagging duplicates with V106. */
function declaredChunkIds(view: DecompositionBodyView, errors: ValidationError[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const chunk of view.chunks) {
    if (seen.has(chunk.chunkId)) duplicates.add(chunk.chunkId);
    seen.add(chunk.chunkId);
  }
  for (const id of duplicates) {
    errors.push({
      code: "V106",
      pointer: "/body/chunks",
      message: `chunk id is declared more than once: ${id}`,
    });
  }
  return [...seen];
}

/** V100 totality (exact partition over offered) and V101 no-duplication. */
function checkTotalityAndDuplication(
  view: DecompositionBodyView,
  offered: ReadonlySet<string>,
  errors: ValidationError[],
): void {
  const chunkCounts = new Map<string, number>();
  for (const chunk of view.chunks) {
    for (const hunkId of chunk.hunkIds) {
      chunkCounts.set(hunkId, (chunkCounts.get(hunkId) ?? 0) + 1);
    }
  }
  for (const [hunkId, count] of chunkCounts) {
    if (count > 1) {
      errors.push({
        code: "V101",
        pointer: "/body/chunks",
        message: `hunk placed in more than one chunk: ${hunkId}`,
      });
    }
  }

  const residueIds = new Set(view.residue.map((item) => item.hunkId));
  const chunkIds = new Set(chunkCounts.keys());

  // A hunk cannot be both placed in a chunk and left in residue.
  for (const hunkId of chunkIds) {
    if (residueIds.has(hunkId)) {
      errors.push({
        code: "V100",
        pointer: "/body/residue",
        message: `hunk is both placed in a chunk and left in residue: ${hunkId}`,
      });
    }
  }

  const placed = new Set<string>([...chunkIds, ...residueIds]);
  for (const offeredId of offered) {
    if (!placed.has(offeredId)) {
      errors.push({
        code: "V100",
        pointer: "/body",
        message: `offered hunk is unaccounted for (not in any chunk or residue): ${offeredId}`,
      });
    }
  }
  for (const placedId of placed) {
    if (!offered.has(placedId)) {
      errors.push({
        code: "V100",
        pointer: "/body",
        message: `hunk is not in the offered manifest (minted or extra): ${placedId}`,
      });
    }
  }
}

/** V104 — every chunk angle is in the closed chunk-assignable set. */
function checkAngles(view: DecompositionBodyView, errors: ValidationError[]): void {
  const allowed = new Set<string>(CHUNK_ASSIGNABLE_ANGLES);
  view.chunks.forEach((chunk, index) => {
    for (const angle of chunk.angles) {
      if (!allowed.has(angle)) {
        errors.push({
          code: "V104",
          pointer: `/body/chunks/${index}/angles`,
          message: `angle is not chunk-assignable (${angle}); allowed: ${CHUNK_ASSIGNABLE_ANGLES.join(", ")}`,
        });
      }
    }
  });
}

/** V105 — every proposal chunk carries a non-empty rationale. */
function checkRationale(view: DecompositionBodyView, errors: ValidationError[]): void {
  view.chunks.forEach((chunk, index) => {
    if ((chunk.rationale ?? "").trim().length === 0) {
      errors.push({
        code: "V105",
        pointer: `/body/chunks/${index}/rationale`,
        message: "proposal chunk rationale is empty",
      });
    }
  });
}

/** V106 — every chunk id referenced by an edge or the reading order is declared. */
function checkCompleteness(
  view: DecompositionBodyView,
  declared: readonly string[],
  errors: ValidationError[],
): void {
  const declaredSet = new Set(declared);
  view.edges.forEach((edge, index) => {
    for (const [end, id] of [
      ["from", edge.from],
      ["to", edge.to],
    ] as const) {
      if (!declaredSet.has(id)) {
        errors.push({
          code: "V106",
          pointer: `/body/edges/${index}/${end}`,
          message: `edge references an undeclared chunk: ${id}`,
        });
      }
    }
  });
  view.readingOrder.forEach((id, index) => {
    if (!declaredSet.has(id)) {
      errors.push({
        code: "V106",
        pointer: `/body/readingOrder/${index}`,
        message: `reading order references an undeclared chunk: ${id}`,
      });
    }
  });
}

/**
 * V103 — the edges are a DAG and `readingOrder` is a topological cover: it lists
 * every declared chunk exactly once and places the source of every edge before
 * its target. Dangling references are V106's job; here we only reason over
 * declared chunks.
 */
function checkReadingOrder(
  view: DecompositionBodyView,
  declared: readonly string[],
  errors: ValidationError[],
): void {
  const declaredSet = new Set(declared);

  // Cover: readingOrder over declared chunks is a permutation (each once).
  const orderDeclared = view.readingOrder.filter((id) => declaredSet.has(id));
  const orderCounts = new Map<string, number>();
  for (const id of orderDeclared) orderCounts.set(id, (orderCounts.get(id) ?? 0) + 1);
  let coverBroken = false;
  for (const id of declared) {
    const count = orderCounts.get(id) ?? 0;
    if (count !== 1) coverBroken = true;
  }
  if (coverBroken) {
    errors.push({
      code: "V103",
      pointer: "/body/readingOrder",
      message: "reading order does not cover every declared chunk exactly once",
    });
  }

  // Acyclicity over declared edges (Kahn: a leftover node means a cycle).
  const declaredEdges = view.edges.filter(
    (edge) => declaredSet.has(edge.from) && declaredSet.has(edge.to),
  );
  if (hasCycle(declared, declaredEdges)) {
    errors.push({ code: "V103", pointer: "/body/edges", message: "edges contain a cycle" });
    return; // a topological-consistency check is meaningless on a cyclic graph
  }

  // Consistency: for every edge from→to, `from` precedes `to` in the order.
  const position = new Map<string, number>();
  view.readingOrder.forEach((id, index) => {
    if (!position.has(id)) position.set(id, index);
  });
  for (const edge of declaredEdges) {
    const fromPos = position.get(edge.from);
    const toPos = position.get(edge.to);
    if (fromPos === undefined || toPos === undefined) continue; // cover error already raised
    if (fromPos >= toPos) {
      errors.push({
        code: "V103",
        pointer: "/body/readingOrder",
        message: `reading order violates edge ${edge.from} -> ${edge.to}`,
      });
    }
  }
}

function hasCycle(
  nodes: readonly string[],
  edges: readonly { from: string; to: string }[],
): boolean {
  const indegree = new Map<string, number>();
  const successors = new Map<string, string[]>();
  for (const node of nodes) {
    indegree.set(node, 0);
    successors.set(node, []);
  }
  for (const edge of edges) {
    successors.get(edge.from)?.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const queue = nodes.filter((node) => (indegree.get(node) ?? 0) === 0);
  let visited = 0;
  while (queue.length > 0) {
    const node = queue.shift();
    if (node === undefined) break;
    visited += 1;
    for (const next of successors.get(node) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  return visited < nodes.length;
}

function pointerOf(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) return "";
  return `/${path.map((segment) => String(segment).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
}
