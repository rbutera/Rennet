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

/**
 * Drop the retired `worktreeBaseDir` answer from a persisted questionnaire and recompute its
 * provenance counts (#812 / #816 re-review P2). A v1 journal written before the field left
 * the questionnaire carries FIVE answers; the current schema requires exactly four, so
 * without this a completed or resumable add-project run fails to load and silently restarts
 * its scout and map — model spend the reviewer never sees. Operates on raw JSON before the
 * current-schema parse. It is IDEMPOTENT: a four-answer journal has no `worktreeBaseDir`
 * answer to drop, and `detected`/`guessed` recomputed off the surviving answers match what
 * `scoutQuestionnaire` already stored (`detected = detected answers`, `guessed = the rest`).
 */
function migrateQuestionnaire(questionnaire: unknown): void {
  if (questionnaire === null || typeof questionnaire !== "object") return;
  const q = questionnaire as { answers?: unknown; detected?: unknown; guessed?: unknown };
  if (!Array.isArray(q.answers)) return;
  const answers = q.answers.filter(
    (answer) =>
      answer === null ||
      typeof answer !== "object" ||
      (answer as { key?: unknown }).key !== "worktreeBaseDir",
  );
  const detected = answers.filter(
    (answer) =>
      answer !== null &&
      typeof answer === "object" &&
      (answer as { provenance?: unknown }).provenance === "detected",
  ).length;
  q.answers = answers;
  q.detected = detected;
  q.guessed = answers.length - detected;
}

/** Migrate every questionnaire a journal can carry: one per repo checkpoint, one per
 *  `scout-ready` event, and the one a `done` event's `run.scout` holds. Returns the same
 *  object for a direct hand-off to the parser. */
function migrateLegacyJournal(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object") return raw;
  const journal = raw as { repos?: unknown; events?: unknown };
  if (Array.isArray(journal.repos)) {
    for (const repo of journal.repos) {
      if (repo !== null && typeof repo === "object") {
        migrateQuestionnaire((repo as { scout?: unknown }).scout);
      }
    }
  }
  if (Array.isArray(journal.events)) {
    for (const event of journal.events) {
      if (event === null || typeof event !== "object") continue;
      const kind = (event as { kind?: unknown }).kind;
      if (kind === "scout-ready") {
        migrateQuestionnaire((event as { questionnaire?: unknown }).questionnaire);
      } else if (kind === "done") {
        // `done.run.scout` is the OTHER questionnaire carrier (wire.ts `done.run` ->
        // `projectProcessRunSchema.scout`). A legacy `done` event whose durable run still
        // holds a five-answer scout fails the current-schema parse exactly like a legacy
        // repo/scout-ready questionnaire, nulling the whole journal and silently re-running.
        const run = (event as { run?: unknown }).run;
        if (run !== null && typeof run === "object") {
          migrateQuestionnaire((run as { scout?: unknown }).scout);
        }
      }
    }
  }
  return raw;
}

export function createProjectProcessJournal(store: ProjectSnapshotStore): ProjectProcessJournal {
  return {
    load(repoKey) {
      try {
        const parsed = projectProcessJournalSchema.safeParse(
          migrateLegacyJournal(
            JSON.parse(readFileSync(join(store.paths(repoKey).projectDir, JOURNAL_FILE), "utf8")),
          ),
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
