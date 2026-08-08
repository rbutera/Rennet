import type {
  Canvas,
  Disposition,
  DispositionAnchor,
  ElementDiffs,
  Patchset,
  Review,
  ReviewNarration,
} from "@rennet/types";
import { z } from "zod";
import { permissionModeSchema } from "./permission-mode";

export * from "./bodies";
export * from "./permission-mode";
export * from "./rsp";
export * from "./sha256";

const fileChangeStatusSchema = z.enum(["added", "modified", "deleted", "renamed"]);

const repositoryProvenanceSchema = z.object({
  id: z.string().min(1),
  root: z.string().min(1),
  commonDir: z.string().min(1),
  baseRef: z.string().min(1),
  baseOid: z.string().min(1),
  headOid: z.string().min(1),
});

export const patchsetSchema: z.ZodType<Patchset> = z.object({
  id: z.string().min(1),
  createdAt: z.iso.datetime(),
  repository: repositoryProvenanceSchema,
  files: z.array(
    z.object({
      path: z.string(),
      previousPath: z.string().optional(),
      status: fileChangeStatusSchema,
      additions: z.number().int().nonnegative().nullable(),
      deletions: z.number().int().nonnegative().nullable(),
      binary: z.boolean(),
      patch: z.string(),
    }),
  ),
  rawDiff: z.string(),
  byteLength: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

export const dispositionTypeSchema = z.enum(["approve", "request-change", "comment", "question"]);

const dispositionAnchorSchema: z.ZodType<DispositionAnchor> = z
  .object({
    path: z.string(),
    contentDigest: z.string().min(1),
    // Optional span anchor (issue #78): a 1-based file-line range on `side`.
    span: z
      .object({
        startLine: z.number().int().min(1),
        endLine: z.number().int().min(1).optional(),
      })
      .optional(),
    side: z.enum(["additions", "deletions", "context"]).optional(),
    spanDigest: z.string().min(1).optional(),
  })
  // span/side/spanDigest are all-or-none: a span anchor needs all three; a
  // path-grained anchor has none. A partial presence is rejected.
  .refine(
    (anchor) =>
      [anchor.span, anchor.side, anchor.spanDigest].filter((field) => field !== undefined).length %
        3 ===
      0,
    { message: "span, side, and spanDigest must all be present (span anchor) or all absent" },
  )
  .refine(
    (anchor) =>
      anchor.span === undefined ||
      anchor.span.endLine === undefined ||
      anchor.span.endLine >= anchor.span.startLine,
    { message: "span.endLine must be >= span.startLine" },
  );

export const dispositionSchema: z.ZodType<Disposition> = z.object({
  anchor: dispositionAnchorSchema,
  type: dispositionTypeSchema,
  body: z.string(),
});

export const reviewSchema: z.ZodType<Review> = z.object({
  id: z.string().min(1),
  repositoryRoot: z.string().min(1),
  patchsets: z.array(patchsetSchema).min(1),
  activePatchsetId: z.string().min(1),
  pendingPatchsetId: z.string().optional(),
  dispositions: z.array(dispositionSchema),
  status: z.enum(["current", "invalid"]),
});

// ── Canvas output schema (issue #54) ─────────────────────────────────────────
// The engine produces canvases from the durable log; this schema validates the
// live canvas set delivered to the renderer over `review.canvases`. It is a full,
// failing-capable schema (not a passthrough) so the IPC output surface has a real
// positive control, mirroring the `Canvas` shape in `@rennet/types`.

const canvasAngleSchema = z.enum(["spec", "sequence", "decisions", "claims", "noise"]);

const substrateChunkRefSchema = z.object({
  chunkId: z.string(),
  hunkIds: z.array(z.string()),
  filePaths: z.array(z.string()),
});

const analysisElementSchema = z.object({
  elementKey: z.string(),
  docId: z.string(),
  anchor: z.string(),
  kind: z.string(),
  title: z.string(),
});

const analysisCohortSchema = z.object({
  cohortKey: z.string(),
  title: z.string(),
  elementKeys: z.array(z.string()),
});

const annotationSchema = z.object({
  annotationId: z.string(),
  target: z.string(),
  kind: z.enum(["highlight", "callout", "link"]),
  body: z.string(),
  pinned: z.boolean(),
});

const proposalSchema = z.object({
  proposalId: z.string(),
  kind: z.enum(["disposition", "regroup", "split"]),
  target: z.string(),
  payload: z.string(),
  status: z.enum(["pending", "accepted", "dismissed"]),
});

const blastRadiusPaintSchema = z.object({ target: z.string(), docId: z.string() });

export const canvasSchema: z.ZodType<Canvas> = z.object({
  canvasId: z.string(),
  reviewId: z.string(),
  patchsetId: z.string(),
  angle: canvasAngleSchema,
  layers: z.object({
    substrate: z.object({ chunks: z.array(substrateChunkRefSchema) }),
    analysis: z.object({
      elements: z.array(analysisElementSchema),
      cohorts: z.array(analysisCohortSchema),
      readingOrder: z.array(z.string()),
    }),
    disposition: z.object({ dispositions: z.array(dispositionSchema) }),
    annotation: z.object({
      annotations: z.array(annotationSchema),
      proposals: z.array(proposalSchema),
    }),
  }),
  overlay: z.array(blastRadiusPaintSchema),
});

/** The five-angle canvas set the live pipeline produces (`Record<CanvasAngle, Canvas>`). */
const canvasSetSchema = z.object({
  spec: canvasSchema,
  sequence: canvasSchema,
  decisions: canvasSchema,
  claims: canvasSchema,
  noise: canvasSchema,
});

// ── Per-element real diff map (issue #60) ────────────────────────────────────
// Delivered ALONGSIDE the canvas set so the zoom surface renders the real
// captured hunk text instead of the `demoDiff` fixture. Keyed by `elementKey`; a
// doc-anchored element (flat angle, no code diff) simply has no entry. A full,
// failing-capable schema (path + diff both required) so the IPC surface keeps a
// real positive control.
const elementDiffSchema = z.object({ path: z.string(), diff: z.string() });
const elementDiffsSchema: z.ZodType<ElementDiffs> = z.record(z.string(), elementDiffSchema);

// ── Roll-up narration placement (issue #70) ──────────────────────────────────
// Delivered ALONGSIDE the canvas set (like `elementDiffs`) so the zoom ladder
// renders the agent's account at each altitude. A discriminated union keeps the
// never-blank contract honest at the IPC boundary: a placement is a narrated
// account or an explicit pending/failed state — there is no shape for "blank".
const narrationEvidenceSchema = z.object({ anchor: z.string(), quote: z.string() });
const narrationPlacementSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("narrated"),
    oneLine: z.string(),
    paragraph: z.string(),
    evidence: z.array(narrationEvidenceSchema).optional(),
  }),
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("failed") }),
]);
const reviewNarrationSchema: z.ZodType<ReviewNarration> = z.object({
  rollup: narrationPlacementSchema,
  cohorts: z.record(z.string(), narrationPlacementSchema),
});

const commandIdSchema = z.uuid();

export const commandDefinitions = {
  "app.bootstrap": {
    input: z.object({}),
    output: z.object({ review: reviewSchema.nullable() }),
  },
  "repository.choose": {
    input: z.object({}),
    output: z.object({ path: z.string().nullable() }),
  },
  "review.capture": {
    input: z.object({
      commandId: commandIdSchema,
      repoPath: z.string().min(1),
      reviewId: z.string().optional(),
    }),
    output: z.object({ review: reviewSchema }),
  },
  "review.setDisposition": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
      patchsetId: z.string().min(1),
      path: z.string(),
      /** A disposition type sets/replaces the disposition; `null` clears it. */
      disposition: dispositionTypeSchema.nullable(),
      body: z.string(),
    }),
    output: z.object({ review: reviewSchema }),
  },
  "review.checkFreshness": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
      repoPath: z.string().min(1),
    }),
    output: z.object({ review: reviewSchema }),
  },
  "review.regenerate": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
      repoPath: z.string().min(1),
    }),
    output: z.object({ review: reviewSchema }),
  },
  // ── Settings: permission modes (issue #103) ────────────────────────────────
  // The workspace-level permission MODE (manual / auto / bypass) that governs
  // gated actions. `settings.permissionMode` reads the persisted default;
  // `settings.setPermissionMode` writes it. The renderer layers a per-run
  // override over this (resolvePermissionMode); the persisted value is the
  // workspace default. First consumer: the #58 Canvases harness-run gate.
  "settings.permissionMode": {
    input: z.object({}),
    output: z.object({ mode: permissionModeSchema }),
  },
  "settings.setPermissionMode": {
    input: z.object({ mode: permissionModeSchema }),
    output: z.object({ mode: permissionModeSchema }),
  },
  // ── Live canvases (issue #54) ──────────────────────────────────────────────
  // Runs the live pipeline (decompose → budget-gated angle → ordering → place)
  // for the review's active patchset and returns the five-angle canvas set the
  // renderer reads. On-demand (opened Canvases view), not on every capture.
  "review.canvases": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
      repoPath: z.string().min(1),
      // The #58/#103 one-shot harness-run consent (bead workspace-j98dt). The
      // renderer sets this `true` when the harness run is permitted for THIS run
      // (the user consented under `manual`, or the mode does not ask). Absent or
      // `false` ⇒ no consent. The MAIN process resolves the effective mode from
      // the persisted workspace default (the authority) and refuses to invoke the
      // harness when that mode asks and this signal is not `true` — so the vital
      // model-spend circuit is enforced at the boundary where the spend happens,
      // not only in the renderer (Rule 75: no single fault clears it).
      consent: z.boolean().optional(),
    }),
    // `elementDiffs` (issue #60): the real per-element diff map delivered with the
    // canvas set so zooming into an element shows real code, not the fixture.
    // `narration` (issue #70): the per-altitude narrated accounts, optional so a
    // desktop build that predates narration still validates (absence → the UI
    // shows the honest pending state, never a crash).
    output: z.object({
      canvases: canvasSetSchema,
      elementDiffs: elementDiffsSchema,
      narration: reviewNarrationSchema.optional(),
    }),
  },
  // ── Canvas user ops (issue #10) ────────────────────────────────────────────
  // The renderer reaches the canvas engine ONLY through this command map (R20).
  // These are the USER surface: `canvas.disposition` is the sovereign L2 write;
  // the orchestrator's ops are MCP tools (canvasOps@2), NOT commands here, so no
  // agent-reachable path can write L2 by construction (structural, see the test).
  "canvas.disposition": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
      patchsetId: z.string().min(1),
      path: z.string(),
      /** A disposition type sets/replaces the disposition; `null` clears it. */
      disposition: dispositionTypeSchema.nullable(),
      body: z.string(),
    }),
    output: z.object({ review: reviewSchema }),
  },
  "canvas.adjudicateProposal": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
      canvasId: z.string().min(1),
      proposalId: z.string().min(1),
      outcome: z.enum(["accepted", "dismissed"]),
    }),
    output: z.object({ review: reviewSchema }),
  },
  "canvas.setCohortExpansion": {
    input: z.object({
      commandId: commandIdSchema,
      canvasId: z.string().min(1),
      cohortKey: z.string().min(1),
      expanded: z.boolean(),
    }),
    output: z.object({ ok: z.boolean() }),
  },
  "canvas.select": {
    input: z.object({
      commandId: commandIdSchema,
      canvasId: z.string().min(1),
      elementKey: z.string().min(1),
    }),
    output: z.object({ ok: z.boolean() }),
  },
  "canvas.pinAnnotation": {
    input: z.object({
      commandId: commandIdSchema,
      canvasId: z.string().min(1),
      annotationId: z.string().min(1),
    }),
    output: z.object({ ok: z.boolean() }),
  },
  "canvas.clearAnnotation": {
    input: z.object({
      commandId: commandIdSchema,
      canvasId: z.string().min(1),
      annotationId: z.string().min(1),
    }),
    output: z.object({ ok: z.boolean() }),
  },
} as const;

export type CommandName = keyof typeof commandDefinitions;
export type CommandInput<K extends CommandName> = z.input<(typeof commandDefinitions)[K]["input"]>;
export type CommandOutput<K extends CommandName> = z.output<
  (typeof commandDefinitions)[K]["output"]
>;

export function isCommandName(value: string): value is CommandName {
  return Object.hasOwn(commandDefinitions, value);
}

export function parseCommandInput<K extends CommandName>(name: K, input: unknown): CommandInput<K> {
  return commandDefinitions[name].input.parse(input) as CommandInput<K>;
}

export function parseCommandOutput<K extends CommandName>(
  name: K,
  output: unknown,
): CommandOutput<K> {
  return commandDefinitions[name].output.parse(output) as CommandOutput<K>;
}

export interface RennetBridge {
  invoke<K extends CommandName>(name: K, input: CommandInput<K>): Promise<CommandOutput<K>>;
}
