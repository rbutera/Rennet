import { z } from "zod";

// ── The Design lens's Superpowers spec (mirrors the OpenSpec change model) ─────
//
// A Superpowers feature ships a fixed, known set of markdown artifacts — a design
// SPEC (`docs/superpowers/specs/<feature>.md`), an execution PLAN with a file-and-
// verification manifest (`docs/superpowers/plans/<date>-<feature>.md`), and a
// PROGRESS ledger that binds to a plan (`.superpowers/sdd/<feature>/progress.md`).
// Because the shape is known ahead of time, the Design board can render it
// structured — plan task groups, per-task manifests, and a plan-vs-progress
// completion state — rather than dumping raw markdown, exactly as the OpenSpec
// change model does for `openspec/changes/<name>/`.
//
// This module is the WIRE model the parser emits and the IPC boundary validates.
// Every reviewable node carries a `source` (artifact + file path + 1-based line)
// so a Spec-view disposition anchors durably against the real artifact file.
//
// NOTE (duplication to unify later): the progress-marker/ledger shapes and the
// task-manifest shape here re-derive the equivalents that
// `packages/core/src/board/design-obligations.ts` already builds
// (`SuperpowersProgressMarker`, `SuperpowersProgressLedger`, `DesignTaskManifest`).
// They are re-derived rather than imported to keep this new contract's footprint
// disjoint from the obligation parser; a follow-up can unify them.

/** Which Superpowers artifact a node came from. */
export const superpowersArtifactSchema = z.enum(["spec", "plan", "progress"]);
export type SuperpowersArtifact = z.infer<typeof superpowersArtifactSchema>;

/**
 * A node's origin: the artifact it belongs to, the repo-relative file `path`, and
 * the 1-based file `line`. Unlike OpenSpec (whose artifact enum names a fixed file),
 * a Superpowers plan/spec lives at an arbitrary path under `docs/superpowers/`, so
 * the path is load-bearing and travels with every node.
 */
export const superpowersSourceSchema = z.object({
  artifact: superpowersArtifactSchema,
  path: z.string(),
  line: z.number(),
});
export type SuperpowersSource = z.infer<typeof superpowersSourceSchema>;

// ── design spec (docs/superpowers/specs/**) ──────────────────────────────────

/** One `##`/`###` section of a design spec: its heading and flattened prose body. */
export const superpowersDesignSectionSchema = z.object({
  id: z.string(),
  level: z.union([z.literal(2), z.literal(3)]),
  heading: z.string(),
  /** The section's prose, headings and rules dropped, whitespace collapsed. */
  body: z.string(),
  source: superpowersSourceSchema.optional(),
});
export type SuperpowersDesignSection = z.infer<typeof superpowersDesignSectionSchema>;

export const superpowersDesignSpecSchema = z.object({
  path: z.string(),
  sections: z.array(superpowersDesignSectionSchema),
});
export type SuperpowersDesignSpec = z.infer<typeof superpowersDesignSpecSchema>;

// ── plan (docs/superpowers/plans/**) ─────────────────────────────────────────

/** A file the task group touches: `- Create|Modify|Test: <value>`. */
export const superpowersManifestFileSchema = z.object({
  operation: z.enum(["create", "modify", "test"]),
  value: z.string(),
});
/** An interface contract the task group carries: `- Consumes|Produces: <value>`. */
export const superpowersManifestInterfaceSchema = z.object({
  direction: z.enum(["consumes", "produces"]),
  value: z.string(),
});
/** A verification pair: a `Run:` command with its `Expected:` outcome. */
export const superpowersManifestVerificationSchema = z.object({
  run: z.string(),
  expected: z.string(),
});
export const superpowersTaskManifestSchema = z.object({
  files: z.array(superpowersManifestFileSchema),
  interfaces: z.array(superpowersManifestInterfaceSchema),
  verifications: z.array(superpowersManifestVerificationSchema),
});
export type SuperpowersTaskManifest = z.infer<typeof superpowersTaskManifestSchema>;

/** One checklist step under a task group. `id` is its `Step N` number or ordinal. */
export const superpowersPlanStepSchema = z.object({
  id: z.string(),
  text: z.string(),
  done: z.boolean(),
  source: superpowersSourceSchema.optional(),
});
export type SuperpowersPlanStep = z.infer<typeof superpowersPlanStepSchema>;

/**
 * A `### Task N: …` group. `state` is the plan-INTERNAL completion the source
 * states: `static` when the group has no checklist steps, else `complete` when
 * every step is checked, else `incomplete`. A progress ledger can override this to
 * `complete` for a task id — that join is board-assembly, not this parser.
 */
export const superpowersTaskGroupSchema = z.object({
  id: z.string(),
  title: z.string(),
  manifest: superpowersTaskManifestSchema.optional(),
  steps: z.array(superpowersPlanStepSchema),
  state: z.enum(["complete", "incomplete", "static"]),
  total: z.number(),
  done: z.number(),
  source: superpowersSourceSchema.optional(),
});
export type SuperpowersTaskGroup = z.infer<typeof superpowersTaskGroupSchema>;

/** A promoted plan-header choice: `**Architecture:**` / `**Tech Stack:**`. */
export const superpowersPlanDecisionSchema = z.object({
  label: z.enum(["Architecture", "Tech Stack"]),
  value: z.string(),
  source: superpowersSourceSchema.optional(),
});
export type SuperpowersPlanDecision = z.infer<typeof superpowersPlanDecisionSchema>;

export const superpowersPlanSchema = z.object({
  path: z.string(),
  /** The plan's `**Goal:**` line, when present. */
  goal: z.string().optional(),
  /** The plan's `**Spec:**` pointer to its design spec, when present. */
  specPath: z.string().optional(),
  /** Promoted `**Architecture:**` / `**Tech Stack:**` header choices, in order. */
  decisions: z.array(superpowersPlanDecisionSchema),
  /** The `## Global Constraints` bullets, in source order. */
  globalConstraints: z.array(z.string()),
  taskGroups: z.array(superpowersTaskGroupSchema),
  /** Group-granular roll-up: `total` groups, `done` groups whose state is complete. */
  total: z.number(),
  done: z.number(),
});
export type SuperpowersPlan = z.infer<typeof superpowersPlanSchema>;

// ── progress ledger (.superpowers/sdd/**/progress.md) ────────────────────────

/**
 * A ledger line's classification, re-derived from `superpowersProgressMarker` in
 * `design-obligations.ts`. The first line of a ledger is a `plan-binding`; the rest
 * are task events or rulings.
 */
export const superpowersProgressMarkerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plan-binding"), planPath: z.string() }),
  z.object({ kind: z.literal("task-complete"), taskId: z.string() }),
  z.object({ kind: z.literal("task-fix-round"), taskId: z.string() }),
  z.object({ kind: z.literal("task-minor"), taskId: z.string() }),
  z.object({ kind: z.literal("ruling") }),
  z.object({ kind: z.literal("other") }),
]);
export type SuperpowersProgressMarker = z.infer<typeof superpowersProgressMarkerSchema>;

/** One classified ledger line, carrying its raw text and 1-based file line. */
export const superpowersProgressEntrySchema = z.intersection(
  superpowersProgressMarkerSchema,
  z.object({ line: z.number(), text: z.string(), source: superpowersSourceSchema.optional() }),
);
export type SuperpowersProgressEntry = z.infer<typeof superpowersProgressEntrySchema>;

export const superpowersProgressLedgerSchema = z.object({
  path: z.string(),
  /** The plan path the ledger's `plan-binding` first line names. */
  planPath: z.string(),
  entries: z.array(superpowersProgressEntrySchema),
});
export type SuperpowersProgressLedger = z.infer<typeof superpowersProgressLedgerSchema>;

// ── the whole feature bundle ─────────────────────────────────────────────────

export const superpowersSpecRawSchema = z.object({
  specs: z.array(z.object({ path: z.string(), md: z.string() })),
  plans: z.array(z.object({ path: z.string(), md: z.string() })),
  progress: z.array(z.object({ path: z.string(), md: z.string() })),
});
export type SuperpowersSpecRaw = z.infer<typeof superpowersSpecRawSchema>;

/**
 * A whole Superpowers feature's parsed artifacts. Absent artifact kinds are simply
 * empty arrays (never absent), mirroring the OpenSpec change model's tolerance: a
 * feature with only a plan parses to `{ plans: [<one>], specs: [], progressLedgers: [] }`.
 */
export const superpowersSpecSchema = z.object({
  name: z.string(),
  specs: z.array(superpowersDesignSpecSchema),
  plans: z.array(superpowersPlanSchema),
  progressLedgers: z.array(superpowersProgressLedgerSchema),
  /** The raw artifact text verbatim, so the Spec viewer flips to it without re-serializing. */
  raw: superpowersSpecRawSchema.optional(),
});
export type SuperpowersSpec = z.infer<typeof superpowersSpecSchema>;
