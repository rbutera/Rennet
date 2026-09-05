import { z } from "zod";

// ── The Design lens's BMAD specification model ───────────────────────────────
// The structured model the BMAD parser emits, the sibling of `openSpecChangeSchema`
// (wire.ts) for the BMAD spec format. A BMAD project ships a PRD, an architecture
// document, and per-feature epic and story documents; each has a known shape, so the
// Design lens can render it structured (requirement registry, technical assumptions,
// tech-stack table, stories with status + acceptance criteria, tasks/subtasks with
// their marks) rather than dumping the raw markdown. Every node's `source` (artifact +
// document path + line) rides across the wire — that is what makes a Design-view
// disposition durable against the real BMAD file.
//
// The `parseBmadSpec` parser (in `@rennet/core`) is node-free (pure string work); this
// schema validates its output at the IPC boundary, exactly as `openSpecChangeSchema`
// validates `parseOpenSpecChange`.

/**
 * A node's source origin: which BMAD artifact kind it came from, the repo-relative
 * document path when the kind has more than one file (epic / story — the analog of
 * OpenSpec's per-capability `capability`), and its 1-based file line.
 */
const bmadSourceSchema = z.object({
  artifact: z.enum(["prd", "architecture", "epic", "story"]),
  /** Repo-relative path of the owning epic/story document; absent for the singleton PRD/architecture. */
  document: z.string().optional(),
  line: z.number(),
});

/**
 * One list item. `lead` is a bolded lead-in phrase pulled out for emphasis (the
 * `**Storage.** the rest…` idiom); `text` is the remainder. Mirrors OpenSpec's list item.
 */
const bmadListItemSchema = z.object({
  lead: z.string().optional(),
  text: z.string(),
  source: bmadSourceSchema.optional(),
});

/** One rendered block of a document section: paragraph, list, fenced code, or table. */
const bmadBlockSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("paragraph"),
    text: z.string(),
    source: bmadSourceSchema.optional(),
  }),
  z.object({
    kind: z.literal("list"),
    ordered: z.boolean(),
    items: z.array(bmadListItemSchema),
    source: bmadSourceSchema.optional(),
  }),
  z.object({
    kind: z.literal("code"),
    language: z.string(),
    code: z.string(),
    source: bmadSourceSchema.optional(),
  }),
  z.object({
    kind: z.literal("table"),
    headers: z.array(z.string()),
    rows: z.array(z.array(z.string())),
    source: bmadSourceSchema.optional(),
  }),
]);

/**
 * One heading's own section: its slug id, markdown level, heading text, and the blocks
 * it owns (stopping at its first child heading, so nested headings render once). The
 * full document tree every BMAD document carries alongside its structured fields.
 */
const bmadSectionSchema = z.object({
  id: z.string(),
  level: z.number(),
  heading: z.string(),
  blocks: z.array(bmadBlockSchema),
  source: bmadSourceSchema.optional(),
});

/** One functional/non-functional requirement from a PRD's Requirements registry (`FR1: …`, `NFR2: …`). */
const bmadRequirementSchema = z.object({
  id: z.string(),
  kind: z.enum(["functional", "non-functional"]),
  text: z.string(),
  source: bmadSourceSchema.optional(),
});

/** One PRD technical-assumption choice (`**Repository Structure:** Monorepo`). */
const bmadTechnicalAssumptionSchema = z.object({
  label: z.string(),
  value: z.string(),
  source: bmadSourceSchema.optional(),
});

/** One row of an architecture Tech Stack table, with its rationale cell pulled out when the table names one. */
const bmadTechStackRowSchema = z.object({
  cells: z.array(z.string()),
  rationale: z.string().optional(),
  source: bmadSourceSchema.optional(),
});

/** An architecture Tech Stack table (`| Category | Technology | … | Rationale |`). */
const bmadTechStackSchema = z.object({
  headers: z.array(z.string()),
  rows: z.array(bmadTechStackRowSchema),
  source: bmadSourceSchema.optional(),
});

/** One acceptance criterion under a story's `Acceptance Criteria` list, in source order. */
const bmadAcceptanceCriterionSchema = z.object({
  id: z.string(),
  text: z.string(),
  source: bmadSourceSchema.optional(),
});

/**
 * One task or subtask checkbox under a story's `Tasks / Subtasks` list.
 * `acceptanceCriteriaRefs` are the ids named by a `(AC: 1, 3)` marker, in source order.
 */
const bmadTaskItemSchema = z.object({
  text: z.string(),
  status: z.enum(["todo", "done"]),
  /** The checkbox's leading indentation width (spaces), so the surface can render nesting. */
  indent: z.number(),
  acceptanceCriteriaRefs: z.array(z.string()).optional(),
  source: bmadSourceSchema.optional(),
});

/**
 * One top-level task and its subtasks. The top-level checkbox IS the group (its `title`
 * and `status`); `items` are its subtasks. `total`/`done` roll up the subtasks.
 */
const bmadTaskGroupSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["todo", "done"]),
  acceptanceCriteriaRefs: z.array(z.string()).optional(),
  items: z.array(bmadTaskItemSchema),
  total: z.number(),
  done: z.number(),
  source: bmadSourceSchema.optional(),
});

/**
 * One story: its id (`1.2`), heading text, the `As a … I want … so that …` statement,
 * its exact status string when the document carries a `Status` section, and its
 * acceptance criteria in source order. A story appears standalone (a story document) or
 * embedded in a PRD/epic.
 */
const bmadStorySchema = z.object({
  id: z.string(),
  title: z.string(),
  statement: z.string(),
  status: z.string().optional(),
  acceptanceCriteria: z.array(bmadAcceptanceCriterionSchema),
  source: bmadSourceSchema.optional(),
});

/**
 * The PRD (`prd.md`): its full section tree, the functional/non-functional requirement
 * registry, the technical-assumption choices, and any stories it enumerates inline.
 */
const bmadPrdSchema = z.object({
  sections: z.array(bmadSectionSchema),
  requirements: z.array(bmadRequirementSchema),
  technicalAssumptions: z.array(bmadTechnicalAssumptionSchema),
  stories: z.array(bmadStorySchema),
});

/** The architecture document (`architecture.md`): its section tree plus a Tech Stack table when present. */
const bmadArchitectureSchema = z.object({
  sections: z.array(bmadSectionSchema),
  techStack: bmadTechStackSchema.optional(),
});

/** One epic document: its path, its section tree, and the stories it enumerates. */
const bmadEpicSchema = z.object({
  path: z.string(),
  sections: z.array(bmadSectionSchema),
  stories: z.array(bmadStorySchema),
});

/** One story document: its path, its section tree, its primary story, and its tasks/subtasks. */
const bmadStoryDocSchema = z.object({
  path: z.string(),
  sections: z.array(bmadSectionSchema),
  story: bmadStorySchema.optional(),
  tasks: z.array(bmadTaskGroupSchema),
});

/**
 * The raw markdown of a BMAD spec's documents, verbatim as read from disk — never a
 * re-serialization of the parsed model (mirrors OpenSpec's `raw`, issue #239).
 * `epics`/`stories` are empty rather than absent when there are no such documents.
 */
const bmadSpecRawSchema = z.object({
  prdMd: z.string().optional(),
  architectureMd: z.string().optional(),
  epics: z.array(z.object({ path: z.string(), md: z.string() })),
  stories: z.array(z.object({ path: z.string(), md: z.string() })),
});

/**
 * A whole parsed BMAD specification. Any document may be absent (a project need not ship
 * an architecture doc); `epics`/`stories` are empty rather than absent when there are no
 * such documents. The `name` is the specification's anchor label (the touched story id,
 * epic, or PRD the reader selected).
 */
export const bmadSpecSchema = z.object({
  name: z.string(),
  prd: bmadPrdSchema.optional(),
  architecture: bmadArchitectureSchema.optional(),
  epics: z.array(bmadEpicSchema),
  stories: z.array(bmadStoryDocSchema),
  raw: bmadSpecRawSchema.optional(),
});

/** A node's source origin (artifact + optional document path + 1-based line). */
export type BmadSource = z.infer<typeof bmadSourceSchema>;
/** One list item; `lead` is a bolded lead-in pulled out, `text` the remainder. */
export type BmadListItem = z.infer<typeof bmadListItemSchema>;
/** One rendered block: paragraph, list, fenced code, or table. */
export type BmadBlock = z.infer<typeof bmadBlockSchema>;
/** One heading's own section: id, level, heading, and the blocks it owns. */
export type BmadSection = z.infer<typeof bmadSectionSchema>;
/** One PRD functional/non-functional requirement (`FR1: …`). */
export type BmadRequirement = z.infer<typeof bmadRequirementSchema>;
/** One PRD technical-assumption choice. */
export type BmadTechnicalAssumption = z.infer<typeof bmadTechnicalAssumptionSchema>;
/** One architecture Tech Stack row. */
export type BmadTechStackRow = z.infer<typeof bmadTechStackRowSchema>;
/** An architecture Tech Stack table. */
export type BmadTechStack = z.infer<typeof bmadTechStackSchema>;
/** One story acceptance criterion. */
export type BmadAcceptanceCriterion = z.infer<typeof bmadAcceptanceCriterionSchema>;
/** One task/subtask checkbox under a story's Tasks / Subtasks list. */
export type BmadTaskItem = z.infer<typeof bmadTaskItemSchema>;
/** One top-level task and its subtasks, with an honest done/total roll-up. */
export type BmadTaskGroup = z.infer<typeof bmadTaskGroupSchema>;
/** One story: id, statement, status, and acceptance criteria. */
export type BmadStory = z.infer<typeof bmadStorySchema>;
/** The PRD: section tree, requirement registry, technical assumptions, and inline stories. */
export type BmadPrd = z.infer<typeof bmadPrdSchema>;
/** The architecture document: section tree plus an optional Tech Stack table. */
export type BmadArchitecture = z.infer<typeof bmadArchitectureSchema>;
/** One epic document: path, section tree, and enumerated stories. */
export type BmadEpic = z.infer<typeof bmadEpicSchema>;
/** One story document: path, section tree, primary story, and tasks/subtasks. */
export type BmadStoryDoc = z.infer<typeof bmadStoryDocSchema>;
/** The raw markdown of a BMAD spec's documents, verbatim as read from disk. */
export type BmadSpecRaw = z.infer<typeof bmadSpecRawSchema>;
/** A whole parsed BMAD specification; any document may be absent. */
export type BmadSpec = z.infer<typeof bmadSpecSchema>;
