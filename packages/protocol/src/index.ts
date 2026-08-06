import type { Patchset, Review } from "@rennet/types";
import { z } from "zod";

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

export const reviewSchema: z.ZodType<Review> = z.object({
  id: z.string().min(1),
  repositoryRoot: z.string().min(1),
  patchsets: z.array(patchsetSchema).min(1),
  activePatchsetId: z.string().min(1),
  pendingPatchsetId: z.string().optional(),
  readPaths: z.array(z.string()),
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
  "review.setFileRead": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
      patchsetId: z.string().min(1),
      path: z.string(),
      read: z.boolean(),
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
