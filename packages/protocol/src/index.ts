import type { Disposition, DispositionAnchor, Patchset, Review } from "@rennet/types";
import { z } from "zod";

export * from "./bodies";
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

const dispositionAnchorSchema: z.ZodType<DispositionAnchor> = z.object({
  path: z.string(),
  contentDigest: z.string().min(1),
});

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
