import { z } from "zod";

// ── The Design lens's Kiro spec (the sibling of the OpenSpec change model) ────
//
// A Kiro feature ships a fixed, known set of artifacts under `.kiro/specs/<feature>/`:
// a `requirements.md` (EARS-style requirements, each a user story plus numbered
// acceptance criteria), a `design.md` (a decision/architecture section tree), a
// `tasks.md` (a numbered checklist whose items carry `_Requirements:` refs and
// completion marks), and a `bugfix.md` variant (current/expected/unchanged behaviour
// sections). Because the shape is known ahead of time, the Design angle renders it
// structured — a requirement/criteria tree, a task checklist plus progress, a section
// tree — rather than dumping the raw markdown. This is the wire contract for the
// structured model the parser (`@rennet/core` `parseKiroSpec`) emits, validated at the
// IPC boundary so the live parse-on-open crosses to the renderer as the exact shape.
//
// Every node's `source` (artifact + 1-based line) rides across — that is what makes a
// Design-view disposition durable against the real artifact file. The model mirrors
// `openSpecChangeSchema`: absent artifacts are simply absent on the result.

const kiroSourceSchema = z.object({
  artifact: z.enum(["requirements", "design", "tasks", "bugfix"]),
  line: z.number(),
});
const kiroListItemSchema = z.object({
  lead: z.string().optional(),
  text: z.string(),
  source: kiroSourceSchema.optional(),
});
const kiroBlockSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("paragraph"),
    text: z.string(),
    source: kiroSourceSchema.optional(),
  }),
  z.object({
    kind: z.literal("list"),
    ordered: z.boolean(),
    items: z.array(kiroListItemSchema),
    source: kiroSourceSchema.optional(),
  }),
  z.object({
    kind: z.literal("code"),
    language: z.string(),
    code: z.string(),
    source: kiroSourceSchema.optional(),
  }),
  z.object({
    kind: z.literal("table"),
    headers: z.array(z.string()),
    rows: z.array(z.array(z.string())),
    source: kiroSourceSchema.optional(),
  }),
]);

// requirements.md — each `### Requirement N` owns a `**User Story:**` and a
// `#### Acceptance Criteria` list of numbered EARS criteria.
const kiroCriterionSchema = z.object({
  /** The full criterion id (`<requirement>.<local>`, e.g. `1.2`) or its local number when unnumbered. */
  id: z.string(),
  /** The verbatim criterion text (`WHEN … THEN the system SHALL …`). */
  text: z.string(),
  /**
   * The split EARS clause when the criterion is a recognised EARS pattern
   * (`WHEN/IF/WHILE/WHERE … THEN/SHALL …`); absent when it is not — a criterion is
   * kept whether or not it splits, so the tree never drops one.
   */
  ears: z.object({ condition: z.string(), response: z.string() }).optional(),
  source: kiroSourceSchema.optional(),
});
const kiroRequirementSchema = z.object({
  /** The requirement's numeric label (`1`, `2.3`) or a slug of its heading when unnumbered. */
  id: z.string(),
  /** The heading text verbatim (`Requirement 1`). */
  label: z.string(),
  /** The `**User Story:**` prose between the heading and its acceptance criteria (`""` when absent). */
  userStory: z.string(),
  acceptanceCriteria: z.array(kiroCriterionSchema),
  source: kiroSourceSchema.optional(),
});
const kiroRequirementsSchema = z.object({
  requirements: z.array(kiroRequirementSchema),
});

// design.md — an ordered section tree (`##`/`###`), rendering decisions, architecture,
// data models, and the rest as structured blocks. The `#` title is the doc's name.
const kiroDesignSchema = z.object({
  sections: z.array(
    z.object({
      id: z.string(),
      level: z.union([z.literal(2), z.literal(3)]),
      heading: z.string(),
      blocks: z.array(kiroBlockSchema),
      source: kiroSourceSchema.optional(),
    }),
  ),
});

// tasks.md — numbered checkboxes grouped by their top-level number; every item carries
// its `_Requirements:` refs and completion mark, with an honest progress roll-up.
const kiroTaskItemSchema = z.object({
  /** The task's number (`1`, `1.1`) when it leads with one, else absent. */
  number: z.string().optional(),
  text: z.string(),
  status: z.enum(["todo", "done"]),
  /** The `_Requirements:` refs bound to this item, in source order (empty when none). */
  requirementRefs: z.array(z.string()),
  source: kiroSourceSchema.optional(),
});
const kiroTaskGroupSchema = z.object({
  id: z.string(),
  title: z.string(),
  items: z.array(kiroTaskItemSchema),
  total: z.number(),
  done: z.number(),
  source: kiroSourceSchema.optional(),
});
const kiroTasksSchema = z.object({
  groups: z.array(kiroTaskGroupSchema),
  total: z.number(),
  done: z.number(),
});

// bugfix.md — the current/expected/unchanged behaviour sections, each rendered as
// structured blocks.
const kiroBugfixSchema = z.object({
  sections: z.array(
    z.object({
      section: z.enum(["current", "expected", "unchanged"]),
      heading: z.string(),
      blocks: z.array(kiroBlockSchema),
      source: kiroSourceSchema.optional(),
    }),
  ),
});

const kiroSpecRawSchema = z.object({
  requirementsMd: z.string().optional(),
  designMd: z.string().optional(),
  tasksMd: z.string().optional(),
  bugfixMd: z.string().optional(),
});

/**
 * A whole parsed Kiro spec. Any artifact may be absent (a feature need not ship a
 * bugfix or a design doc). The `feature` is the `.kiro/specs/<feature>/` directory
 * name.
 */
export const kiroSpecSchema = z.object({
  feature: z.string(),
  requirements: kiroRequirementsSchema.optional(),
  design: kiroDesignSchema.optional(),
  tasks: kiroTasksSchema.optional(),
  bugfix: kiroBugfixSchema.optional(),
  raw: kiroSpecRawSchema.optional(),
});

/** A node's source origin within a Kiro artifact: which file + its 1-based line. */
export type KiroSource = z.infer<typeof kiroSourceSchema>;
/**
 * One list item. `lead` is a bolded lead-in phrase pulled out for emphasis; `text` is
 * the remainder. When there is no bold lead, `lead` is absent and `text` is the whole item.
 */
export type KiroListItem = z.infer<typeof kiroListItemSchema>;
/** One rendered block in a design/bugfix section: paragraph, list, code, or table. */
export type KiroBlock = z.infer<typeof kiroBlockSchema>;
/** One acceptance criterion under a requirement, with its EARS split when it has one. */
export type KiroCriterion = z.infer<typeof kiroCriterionSchema>;
/** One requirement: its user story plus its numbered acceptance criteria. */
export type KiroRequirement = z.infer<typeof kiroRequirementSchema>;
/** The requirements doc: the ordered requirement/criteria tree. */
export type KiroRequirements = z.infer<typeof kiroRequirementsSchema>;
/** The design doc, as an ordered section list (a table of contents is derivable from it). */
export type KiroDesign = z.infer<typeof kiroDesignSchema>;
/** One task item: its number, completion mark, and `_Requirements:` refs. */
export type KiroTaskItem = z.infer<typeof kiroTaskItemSchema>;
/** One task group: a top-level-numbered checklist plus its roll-up. */
export type KiroTaskGroup = z.infer<typeof kiroTaskGroupSchema>;
/** The tasks doc: the grouped checklists plus an honest whole-feature roll-up. */
export type KiroTasks = z.infer<typeof kiroTasksSchema>;
/** The bugfix doc: the current/expected/unchanged behaviour sections. */
export type KiroBugfix = z.infer<typeof kiroBugfixSchema>;
/**
 * The raw markdown of a Kiro spec's artifacts, verbatim as read from disk — never a
 * re-serialization of the parsed model.
 */
export type KiroSpecRaw = z.infer<typeof kiroSpecRawSchema>;
/**
 * A whole parsed Kiro spec. Any artifact may be absent; the `feature` is the
 * `.kiro/specs/<feature>/` directory name.
 */
export type KiroSpec = z.infer<typeof kiroSpecSchema>;
