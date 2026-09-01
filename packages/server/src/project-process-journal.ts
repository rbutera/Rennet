import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ProjectSnapshotStore, writeAtomic } from "@rennet/adapters";
import {
  type ProjectProcessEvent,
  processedRepoSummarySchema,
  projectProcessEventSchema,
  projectScoutQuestionnaireSchema,
} from "@rennet/protocol";
import { z } from "zod";

const snapshotCheckpointSchema = z.object({
  summary: processedRepoSummarySchema,
  baseOid: z.string().min(1),
  scopes: z.number().int().nonnegative(),
});

const repoCheckpointSchema = z.object({
  repo: z.string().min(1),
  path: z.string().min(1),
  scout: projectScoutQuestionnaireSchema.optional(),
  snapshot: snapshotCheckpointSchema.optional(),
});

const processFailureSchema = z.object({
  repo: z.string().min(1),
  path: z.string().min(1),
  phase: z.enum(["scout", "map", "knowledge"]),
  reason: z.string().min(1),
  summary: processedRepoSummarySchema.optional(),
});

export const projectProcessJournalSchema = z.object({
  version: z.literal(1),
  runId: z.uuid(),
  projectId: z.string().min(1),
  status: z.enum(["queued", "running", "done", "failed"]),
  phase: z.enum(["scout", "map", "knowledge", "complete"]),
  repos: z.array(repoCheckpointSchema),
  failures: z.array(processFailureSchema),
  events: z.array(projectProcessEventSchema),
});

export type ProjectProcessJournalRecord = z.infer<typeof projectProcessJournalSchema>;
export type ProjectProcessRepoCheckpoint = z.infer<typeof repoCheckpointSchema>;
export type ProjectProcessFailure = z.infer<typeof processFailureSchema>;

export interface ProjectProcessJournal {
  load(repoKey: string): ProjectProcessJournalRecord | null;
  save(repoKey: string, record: ProjectProcessJournalRecord): void;
}

const JOURNAL_FILE = "project-process.json";

export function createProjectProcessJournal(store: ProjectSnapshotStore): ProjectProcessJournal {
  return {
    load(repoKey) {
      try {
        const parsed = projectProcessJournalSchema.safeParse(
          JSON.parse(readFileSync(join(store.paths(repoKey).projectDir, JOURNAL_FILE), "utf8")),
        );
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
    save(repoKey, record) {
      const parsed = projectProcessJournalSchema.parse(record);
      writeAtomic(
        join(store.paths(repoKey).projectDir, JOURNAL_FILE),
        `${JSON.stringify(parsed, null, 2)}\n`,
      );
    },
  };
}

/**
 * Keep the latest state of each logical step. A retry may run a step again, but
 * replay still renders one row whose status advances instead of duplicated rows.
 */
export function upsertProjectProcessEvent(
  events: readonly ProjectProcessEvent[],
  event: ProjectProcessEvent,
): ProjectProcessEvent[] {
  const key = projectProcessEventKey(event);
  const prior = events.findIndex((candidate) => projectProcessEventKey(candidate) === key);
  if (prior < 0) return [...events, event];
  return events.map((candidate, index) => (index === prior ? event : candidate));
}

function projectProcessEventKey(event: ProjectProcessEvent): string {
  switch (event.kind) {
    case "run-state":
      return `run:${event.runId}`;
    case "step":
      return `step:${event.runId}:${event.repo}:${event.phase}:${event.step}`;
    case "scout-ready":
      return `scout:${event.runId}:${event.repo}`;
    case "repo-start":
      return `repo-start:${event.repo}`;
    case "repo-done":
    case "repo-error":
      return `repo-terminal:${event.repo}`;
    case "stage":
      return `legacy-stage:${event.repo}:${event.stage}:${event.note}`;
    case "done":
      return "done";
  }
}
