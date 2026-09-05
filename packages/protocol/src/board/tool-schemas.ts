import type { AuthoredSchema } from "@wboard/core";
import { z } from "zod";
import {
  authorableKindsFor,
  type BoardTarget,
  hostDerivedMemberKind,
  hostSettlesAbsenceFor,
  type LensAbsenceReason,
  settleAbsentReasonFor,
  TYPED_KINDS_BY_TARGET,
} from "./kind-tables";
import {
  AUTHORED_BOARD_SCHEMA,
  BoardDocumentSchema,
  type DraftKind,
  HOST_KIND_SCHEMAS,
} from "./schema";

/**
 * The board tool surface — what a seat writes its board WITH (`lens-board-tools` D2/D3).
 *
 * A board is no longer one returned document; it is written call by call. So the
 * model-facing contract is a set of tool INPUTS, and this module derives them by
 * iterating the tables that already decide what a lens authors — exactly the way
 * `buildAppTools` iterates the command registry:
 *
 *   `authorableKindsFor(target)`  → which verbs exist
 *   `AUTHORED_BOARD_SCHEMA[kind]` → which fields, their descriptions, and which of them
 *                                   are element references
 *   `HOST_KIND_SCHEMAS[kind]`     → the exact Zod scalar for a field, so an enum's
 *                                   vocabulary travels rather than being retyped
 *
 * There is no per-lens list here. Add a kind to a lens row in
 * {@link TYPED_KINDS_BY_TARGET} and that lens's verbs appear; nothing else is edited.
 *
 * ── The shape rule (D3, and the whole answer to #810) ────────────────────────────
 * Every input is ONE object of scalars, string enums and arrays of scalars. No nested
 * object, no array of objects, no union at any depth — because
 * `z.union([DraftBoardSchema, DesignNoSpecSchema])` rendered as `{ $schema, anyOf }`
 * with no top-level `type` and the API refused the turn before the model saw it
 * (`400 tools.9.custom.input_schema.type: Field required`). A fixed union is a fix for
 * one schema; a surface in which a union cannot be WRITTEN is the fix for the class.
 * {@link flatInputViolations} is that assertion, and `tool-schemas.test.ts` runs it over
 * every tool of every target.
 *
 * So a structured value is flattened rather than nested: a `SourceRef` becomes
 * `source_path` / `source_candidate` / `source_line`, an ask becomes `ask_ref` /
 * `ask_text`, and a citation is not an object at all but an id returned by `cite`.
 *
 * ── What a seat is not given ─────────────────────────────────────────────────────
 * {@link HOST_OWNED_FIELDS} names the fields the host writes. They appear on no input,
 * so a seat cannot forge one: the element `author` (the seat is known from its address),
 * a `code_ref`'s `patchset_id` (stamped once before persistence; a seat is never told
 * the capture's id), a noise verdict's `judge` (a seat is `llm`), a finding's `status`
 * (a draft is `open`) and its `concurrence` / `accord` (computed by `reconcileFindings`
 * when both Flagged voices have settled), a section's round-`delta` stamp (set by the
 * composition step at regeneration — a seat that could set it could mark its own work
 * new), and the document `measure` (`resolveBoardDocument` overrides whatever a seat
 * authors with the target's own).
 *
 * `children` is absent for a different reason: the host maintains it from the
 * `parent_id` each creating call names (D4), so the tree is always orderable.
 */

// ── The verb grammar ─────────────────────────────────────────────────────────

/** What a tool does. `add`/`update` carry the kind they author. */
export type BoardToolVerb =
  | "set_document"
  | "add"
  | "update"
  | "remove_element"
  | "settle_absent"
  | "finish";

/**
 * The verb noun for each kind. A rename table, not a tool list: WHICH of these appear
 * on a target is decided by {@link authorableKindsFor}, and a kind with no row here
 * makes {@link buildBoardTools} throw rather than quietly lose its verbs.
 */
const VERB_NOUN: Readonly<Partial<Record<DraftKind, { add: string; update: string }>>> = {
  section: { add: "add_section", update: "update_section" },
  prose: { add: "add_prose", update: "update_prose" },
  callout: { add: "add_callout", update: "update_callout" },
  annotation: { add: "add_annotation", update: "update_annotation" },
  code_ref: { add: "cite", update: "update_citation" },
  finding: { add: "add_finding", update: "update_finding" },
  decision: { add: "add_decision", update: "update_decision" },
  requirement: { add: "add_requirement", update: "update_requirement" },
  order_step: { add: "add_step", update: "update_step" },
  noise_verdict: { add: "add_noise_verdict", update: "update_noise_verdict" },
  round_outcome: { add: "add_outcome", update: "update_outcome" },
};

// ── Host-owned and host-maintained fields ────────────────────────────────────

/** Fields the HOST writes; they appear on no tool input. See the module note. */
export const HOST_OWNED_FIELDS: Readonly<Partial<Record<DraftKind, readonly string[]>>> = {
  finding: ["concurrence", "accord", "status"],
  // Both host-stamped constants once membership is derived (D16f): every member is a
  // region no other board cited, so `verdict` is `noise` and `judge` is `deterministic`
  // on all of them, always. A one-valued enum on an input is worse than no field — it
  // renders as a choice, and a model offered a choice will eventually take the other
  // branch — which is why `flatInputViolations` now fails on one.
  noise_verdict: ["judge", "verdict"],
  code_ref: ["patchset_id"],
  section: ["delta"],
};

/** `author` is on every kind and is never a seat's to write. */
const UNIVERSAL_HOST_OWNED: readonly string[] = ["author"];

/** Maintained by the host from `parent_id`, so a child names its parent (D4). */
const HOST_MAINTAINED_FIELDS: readonly string[] = ["children"];

/** Document fields the host owns: `resolveBoardDocument` forces the target's measure. */
const HOST_OWNED_DOCUMENT_FIELDS: readonly string[] = ["measure"];

// ── Renames and flattenings ──────────────────────────────────────────────────

/**
 * The input name for each element-reference field (D4's own names). Keyed by the
 * schema field, so two kinds sharing a field share its input name. A reference field
 * with no row here makes {@link buildBoardTools} throw: a new one must be named
 * deliberately, never defaulted into the surface.
 */
const ELEMENT_INPUT_NAME: Readonly<Record<string, string>> = {
  code: "code_ref_ids",
  code_ref: "code_ref_id",
  evidence: "evidence_ref_ids",
  alternatives: "alternative_ids",
  scenarios: "scenario_ids",
  trace: "trace_ref_ids",
  span: "span_ref_id",
  hunk: "hunk_ref_id",
};

interface JsonPart {
  /** The key inside the structured value (`path`, `candidate`, `line`, `ref`, …). */
  readonly part: string;
  /** The input field name for the single-valued form; the list form appends `s`. */
  readonly name: string;
  readonly schema: z.ZodType;
}

/**
 * How each structured (`json`) field is flattened into named scalars (D3). A `json`
 * field with no row here makes {@link buildBoardTools} throw, so a new structured
 * field cannot silently arrive as a nested object and re-open #810.
 *
 * A LIST-valued field carries only the parts that are worth the alignment. Its parts
 * arrive as parallel arrays a seat has to keep in step by index, and every extra part
 * is one more way to get that wrong: `sources` therefore carries `source_paths` alone,
 * while the SINGLE-valued `source` on a requirement or a decision keeps the whole
 * `path` / `candidate` / `line` triple, where candidate and line are load-bearing and
 * there is no index to align. `stats` keeps both of its parts because a label with no
 * value is not a stat — and the writer refuses a stat list whose two arrays disagree,
 * rather than quietly building the shorter one.
 */
const JSON_FLATTENING: Readonly<Record<string, readonly JsonPart[]>> = {
  source: [
    { part: "path", name: "source_path", schema: z.string().min(1) },
    { part: "candidate", name: "source_candidate", schema: z.string().min(1) },
    { part: "line", name: "source_line", schema: z.number().int().positive() },
  ],
  sources: [{ part: "path", name: "source_path", schema: z.string().min(1) }],
  ask: [
    { part: "ref", name: "ask_ref", schema: z.string().min(1) },
    { part: "text", name: "ask_text", schema: z.string() },
  ],
  stats: [
    { part: "label", name: "stat_label", schema: z.string().min(1) },
    { part: "value", name: "stat_value", schema: z.string() },
  ],
};

/** Prose for each flattened part, so the rename carries its own documentation. */
const JSON_PART_TEXT: Readonly<Record<string, string>> = {
  "source.path": "Repo-relative path of the source artifact.",
  "source.candidate": "Id of the discovered candidate that artifact belongs to.",
  "source.line": "1-based line in the source artifact.",
  "sources.path": "Repo-relative path of a source artifact this board reads.",
  "ask.ref": "The ask this outcome answers.",
  "ask.text": "The ask's display text.",
  "stats.label": "Stat label shown in the board header.",
  "stats.value": "Stat value shown beside its label.",
};

// ── The field plan (what the writer reconstitutes an element from) ───────────

/** Where a tool input field lands in the element's `data`. */
export type BoardToolFieldSource =
  | { readonly form: "scalar"; readonly dataField: string }
  | { readonly form: "element-ref"; readonly dataField: string; readonly many: boolean }
  | {
      readonly form: "json-part";
      readonly dataField: string;
      readonly part: string;
      readonly many: boolean;
    };

/** One field of a tool's input, and the element field it feeds. */
export interface BoardToolField {
  readonly name: string;
  readonly schema: z.ZodType;
  readonly required: boolean;
  readonly description: string;
  readonly source: BoardToolFieldSource;
}

/** One board tool: its name, what it does, and the flat object it takes. */
export interface BoardTool {
  readonly name: string;
  readonly verb: BoardToolVerb;
  /** The element kind an `add`/`update` authors; absent on the board-level verbs. */
  readonly kind?: DraftKind;
  readonly description: string;
  /**
   * The content fields, in schema order. `element_id` and `parent_id` are structural
   * and are not here — the writer reads them off the raw input.
   */
  readonly fields: readonly BoardToolField[];
  /** The rendered input: one flat object. */
  readonly input: z.ZodObject;
}

// ── Reading the authored + host schemas ──────────────────────────────────────

type Attr = AuthoredSchema[string]["attributes"][string];

const isMany = (attr: Attr): boolean => "many" in attr && attr.many === true;

/** Strip an `.optional()` wrapper so a field's own schema can be re-required. */
function unwrapOptional(schema: z.ZodType): z.ZodType {
  return schema instanceof z.ZodOptional ? (schema.unwrap() as z.ZodType) : schema;
}

/** The per-field Zod of a kind's `data`, so an enum's vocabulary is reused, not retyped. */
function dataShapeOf(kind: DraftKind): Readonly<Record<string, z.ZodType>> {
  const data = HOST_KIND_SCHEMAS[kind].shape.data;
  if (!(data instanceof z.ZodObject)) {
    throw new Error(`board tools: \`${kind}\`'s data schema is not an object shape`);
  }
  return data.shape as Record<string, z.ZodType>;
}

function scalarFor(kind: DraftKind, field: string): z.ZodType {
  const declared = dataShapeOf(kind)[field];
  if (declared === undefined) {
    throw new Error(
      `board tools: \`${kind}.${field}\` is authored but absent from its data schema`,
    );
  }
  return unwrapOptional(declared);
}

// ── Field derivation ─────────────────────────────────────────────────────────

/**
 * The sentence that tells a list-form flattening how it lines up. The first part is the
 * spine every other part is aligned against, so it does not point at itself.
 */
function alignmentNote(parts: readonly JsonPart[], index: number): string {
  return index === 0
    ? " One per entry."
    : ` One per entry, index-aligned with \`${parts[0]?.name}s\`.`;
}

function elementRefField(field: string, attr: Attr): BoardToolField {
  const base = ELEMENT_INPUT_NAME[field];
  if (base === undefined) {
    throw new Error(
      `board tools: element-reference field \`${field}\` has no input name. Name it in ELEMENT_INPUT_NAME.`,
    );
  }
  const many = isMany(attr);
  const id = z.string().min(1);
  return {
    name: base,
    schema: many ? z.array(id) : id,
    required: attr.required,
    description: `${attr.description} Give the id${many ? "s" : ""} an earlier call returned.`,
    source: { form: "element-ref", dataField: field, many },
  };
}

function jsonFields(field: string, attr: Attr): BoardToolField[] {
  const parts = JSON_FLATTENING[field];
  if (parts === undefined) {
    throw new Error(
      `board tools: structured field \`${field}\` has no flattening. Flatten it in JSON_FLATTENING — a nested object on a tool input is what #810 was.`,
    );
  }
  const many = isMany(attr);
  return parts.map((part, index) => ({
    name: many ? `${part.name}s` : part.name,
    schema: many ? z.array(part.schema) : part.schema,
    // A list form is index-aligned, so only its first part can carry the field's own
    // required-ness; the rest ride along optionally.
    required: attr.required && (!many || index === 0),
    description: many
      ? `${JSON_PART_TEXT[`${field}.${part.part}`] ?? ""}${alignmentNote(parts, index)}`
      : (JSON_PART_TEXT[`${field}.${part.part}`] ?? ""),
    source: { form: "json-part", dataField: field, part: part.part, many },
  }));
}

/** Every input field of a kind's `add` verb, derived from its two schema declarations. */
export function toolFieldsForKind(kind: DraftKind): readonly BoardToolField[] {
  const hostOwned = new Set([...UNIVERSAL_HOST_OWNED, ...(HOST_OWNED_FIELDS[kind] ?? [])]);
  const maintained = new Set(HOST_MAINTAINED_FIELDS);
  const out: BoardToolField[] = [];
  for (const [field, attr] of Object.entries(AUTHORED_BOARD_SCHEMA[kind].attributes)) {
    if (hostOwned.has(field) || maintained.has(field)) continue;
    if (attr.type === "element") {
      out.push(elementRefField(field, attr));
    } else if (attr.type === "json") {
      out.push(...jsonFields(field, attr));
    } else {
      out.push({
        name: field,
        schema: scalarFor(kind, field),
        required: attr.required,
        description: attr.description,
        source: { form: "scalar", dataField: field },
      });
    }
  }
  return out;
}

/** `set_document`'s fields, derived from {@link BoardDocumentSchema} the same way. */
export function documentToolFields(): readonly BoardToolField[] {
  const hostOwned = new Set(HOST_OWNED_DOCUMENT_FIELDS);
  const shape = BoardDocumentSchema.shape as Record<string, z.ZodType>;
  const out: BoardToolField[] = [];
  for (const [field, declared] of Object.entries(shape)) {
    if (hostOwned.has(field)) continue;
    const required = !(declared instanceof z.ZodOptional);
    const parts = JSON_FLATTENING[field];
    if (parts !== undefined) {
      out.push(
        ...parts.map((part, index) => ({
          name: `${part.name}s`,
          schema: z.array(part.schema),
          required: required && index === 0,
          description: `${JSON_PART_TEXT[`${field}.${part.part}`] ?? ""}${alignmentNote(parts, index)}`,
          source: {
            form: "json-part" as const,
            dataField: field,
            part: part.part,
            many: true,
          },
        })),
      );
      continue;
    }
    out.push({
      name: field === "introMarkdown" ? "intro_markdown" : field,
      schema: unwrapOptional(declared),
      required,
      description:
        field === "title" ? "The board's title." : "The board's opening prose, as markdown.",
      source: { form: "scalar", dataField: field },
    });
  }
  return out;
}

// ── Assembling one tool ──────────────────────────────────────────────────────

const PARENT_ID = z
  .string()
  .min(1)
  .optional()
  .describe(
    "The id of the section or step this element sits under. Omit for a top-level element; the host maintains the parent's children.",
  );

const ELEMENT_ID = z.string().min(1).describe("The id of the element to change.");

function objectOf(
  fields: readonly BoardToolField[],
  extra: Record<string, z.ZodType>,
): z.ZodObject {
  const shape: Record<string, z.ZodType> = { ...extra };
  for (const field of fields) {
    shape[field.name] = (field.required ? field.schema : field.schema.optional()).describe(
      field.description,
    );
  }
  return z.object(shape);
}

function addTool(kind: DraftKind): BoardTool {
  const noun = VERB_NOUN[kind];
  if (noun === undefined) throw new Error(`board tools: \`${kind}\` has no verb noun`);
  const fields = toolFieldsForKind(kind);
  return {
    name: noun.add,
    verb: "add",
    kind,
    description: AUTHORED_BOARD_SCHEMA[kind].description,
    fields,
    input: objectOf(fields, { parent_id: PARENT_ID }),
  };
}

/**
 * `update_<kind>`, and — when the HOST derives this kind's membership (D16) — the only
 * verb the seat has for it.
 *
 * `reparents` is that case. A seat normally names an element's parent once, on the call
 * that creates it, so an update carries no `parent_id`; but a derived member is created
 * by the host before the seat's first turn, and grouping it is precisely the seat's job.
 * The parenting has to ride the one verb the seat is left with.
 */
function updateTool(kind: DraftKind, reparents = false): BoardTool {
  const noun = VERB_NOUN[kind];
  if (noun === undefined) throw new Error(`board tools: \`${kind}\` has no verb noun`);
  // Every field is optional on an update: the call carries only what changes.
  const fields = toolFieldsForKind(kind).map((field) => ({ ...field, required: false }));
  return {
    name: noun.update,
    verb: "update",
    kind,
    description: reparents
      ? `Group an existing \`${kind}\` under a section and say why it is there. Only the fields given change.`
      : `Change fields of an existing \`${kind}\` element. Only the fields given change.`,
    fields,
    input: objectOf(
      fields,
      reparents ? { element_id: ELEMENT_ID, parent_id: PARENT_ID } : { element_id: ELEMENT_ID },
    ),
  };
}

function documentTool(): BoardTool {
  const fields = documentToolFields();
  return {
    name: "set_document",
    verb: "set_document",
    description:
      "Set the board's title and opening prose. Calling it again REPLACES the document: give every field you still want.",
    fields,
    input: objectOf(fields, {}),
  };
}

function removeTool(): BoardTool {
  return {
    name: "remove_element",
    verb: "remove_element",
    description: "Remove an element you added, and everything that hangs beneath it.",
    fields: [],
    input: z.object({ element_id: ELEMENT_ID }),
  };
}

function settleAbsentTool(reason: LensAbsenceReason): BoardTool {
  return {
    name: "settle_absent",
    verb: "settle_absent",
    // The reason is the lens's one admissible absence and is NOT a field: there is
    // nowhere for a seat to name an absence its lens does not admit.
    description: `Settle this lens as \`${reason}\`: say in one note what you looked for and why there is nothing to render.`,
    fields: [],
    input: z.object({
      note: z.string().min(1).describe("What you looked for, and why there is nothing to render."),
    }),
  };
}

function finishTool(): BoardTool {
  return {
    name: "finish",
    verb: "finish",
    description:
      "Finish the board. Either it settles, or you get back a list of pointers to fix with further calls before finishing again.",
    fields: [],
    input: z.object({}),
  };
}

// ── The surface ──────────────────────────────────────────────────────────────

/**
 * The tool set for one drafting target, DERIVED from `SHARED_KINDS ∪ typed kinds`.
 *
 * `table` exists so a test can vary the typed-kind assignment and watch the verbs
 * follow with no per-lens list edited — which is the property the derivation is for.
 */
export function buildBoardTools(
  target: BoardTarget,
  table: Readonly<Record<BoardTarget, readonly DraftKind[]>> = TYPED_KINDS_BY_TARGET,
): readonly BoardTool[] {
  const kinds = authorableKindsFor(target, table);
  // The kind whose membership the host derives, when this target has one (D16). It is
  // read three times below and nowhere else in this module: the add verb goes, the
  // update verb grows the parenting the add verb used to carry, and `settle_absent`
  // goes with it. Every other target has no row and is unaffected.
  const derived = hostDerivedMemberKind(target);
  const absence = hostSettlesAbsenceFor(target) ? undefined : settleAbsentReasonFor(target);
  return [
    documentTool(),
    // No verb creates a derived member: one the seat could add would be a region another
    // board cited, which the ruling forbids. `remove_element` refusing one is the board
    // writer's half of the same rule — removing a member breaks the complement's totality.
    ...kinds.filter((kind) => kind !== derived).map((kind) => addTool(kind)),
    ...kinds.map((kind) => updateTool(kind, kind === derived)),
    removeTool(),
    ...(absence === undefined ? [] : [settleAbsentTool(absence)]),
    finishTool(),
  ];
}

/** The tools of `target`, keyed by name. */
export function boardToolsByName(
  target: BoardTarget,
  table: Readonly<Record<BoardTarget, readonly DraftKind[]>> = TYPED_KINDS_BY_TARGET,
): ReadonlyMap<string, BoardTool> {
  return new Map(buildBoardTools(target, table).map((tool) => [tool.name, tool]));
}

// ── The shape assertion (D3) ─────────────────────────────────────────────────

const SCALAR_JSON_TYPES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);
const COMBINATORS: readonly string[] = ["anyOf", "oneOf", "allOf", "not"];

/**
 * Every way a tool input can be inadmissible to a provider's tool schema, as plain
 * sentences naming the tool and the field.
 *
 * This is the executable form of D3, and the reason it is a shared function rather than
 * inline test assertions: `tool-schemas.test.ts` runs it over every real tool AND over a
 * probe carrying a deliberate union, so the suite proves the check fires as well as
 * proving it passes. An empty array is an admissible input.
 */
export function flatInputViolations(toolName: string, input: z.ZodType): string[] {
  const rendered = z.toJSONSchema(input, { io: "input" }) as Record<string, unknown>;
  const out: string[] = [];

  const walk = (node: unknown, at: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => {
        walk(item, `${at}[${index}]`);
      });
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    for (const combinator of COMBINATORS) {
      if (combinator in record) {
        out.push(
          `${toolName}: \`${at}\` renders as \`${combinator}\`. A tool input carries scalars, string enums and arrays of scalars — never a union of shapes (#810).`,
        );
      }
    }
    for (const [key, value] of Object.entries(record)) {
      if (key === "properties" || key === "$defs" || key === "definitions") {
        for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
          walk(child, at === "" ? name : `${at}.${name}`);
        }
      } else if (key === "items" || key === "prefixItems" || key === "additionalProperties") {
        walk(value, `${at}[]`);
      }
    }
  };

  if (rendered.type !== "object") {
    out.push(
      `${toolName}: the rendered input declares no top-level \`"type": "object"\` — this is exactly the \`400 tools.N.custom.input_schema.type: Field required\` shape (#810).`,
    );
  }
  walk(rendered, "");

  // Every property is a scalar, a string enum, or an array of those. A nested object
  // carries a `type` the combinator walk above would never flag.
  const properties = (rendered.properties ?? {}) as Record<string, unknown>;
  for (const [name, raw] of Object.entries(properties)) {
    if (raw === null || typeof raw !== "object") continue;
    const property = raw as Record<string, unknown>;
    const type = property.type;
    if (type === "array") {
      const items = property.items as Record<string, unknown> | undefined;
      const itemType = items?.type;
      if (typeof itemType !== "string" || !SCALAR_JSON_TYPES.has(itemType)) {
        out.push(
          `${toolName}: \`${name}\` is an array of \`${String(itemType)}\` — a tool input carries arrays of scalars only, never an array of objects.`,
        );
      }
      continue;
    }
    if (typeof type !== "string" || !SCALAR_JSON_TYPES.has(type)) {
      out.push(
        `${toolName}: \`${name}\` renders as \`${String(type)}\` — a tool input field is a scalar, a string enum, or an array of those.`,
      );
    }
    const single = oneValuedEnum(property);
    if (single !== undefined) {
      out.push(
        `${toolName}: \`${name}\` is an enum with one value (\`${single}\`) — a field with one admissible value states a choice that does not exist. The host stamps it (D16f).`,
      );
    }
  }
  return out;
}

/**
 * The single value of a one-valued enum, or `undefined`.
 *
 * A separate screen from the scalar walk above, because a one-valued enum IS a scalar and
 * renders perfectly admissibly: `{"type":"string","enum":["noise"]}` is a legal tool input,
 * and that is the problem. D16f's ruling is that a field a seat can only fill one way is
 * worse than no field — the model reads it as a decision and will eventually take the
 * branch that does not exist — so it is refused by name.
 *
 * `const` is checked too: `z.literal()` renders that way rather than as a one-entry
 * `enum`, and a rule that only saw `enum` would let the same defect in through the other
 * door.
 */
function oneValuedEnum(property: Record<string, unknown>): string | undefined {
  if ("const" in property) return String(property.const);
  const values = property.enum;
  if (!Array.isArray(values) || values.length !== 1) return undefined;
  return String(values[0]);
}
