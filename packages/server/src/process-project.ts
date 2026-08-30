import { basename } from "node:path";
import type { GenerateOptions, GenerateResult, KnowledgeSwarmOutcome } from "@rennet/adapters";
import {
  commandIdFor,
  type KnowledgeSet,
  type ProcessedRepoSummary,
  type Project,
  type ProjectProcessEvent,
  type ProjectProcessRun,
  type ProjectScoutQuestionnaire,
} from "@rennet/protocol";
import {
  type ProjectProcessFailure,
  type ProjectProcessJournal,
  type ProjectProcessJournalRecord,
  upsertProjectProcessEvent,
} from "./project-process-journal";

export interface ProjectScoutRunInput {
  readonly projectId: string;
  readonly runId: string;
  readonly repoKey: string;
  readonly repoRoot: string;
  readonly defaultBranch: string;
  readonly narrate: (event: ProjectProcessEvent) => void;
}

export interface ProjectKnowledgeRunInput {
  readonly projectId: string;
  readonly runId: string;
  readonly repoKey: string;
  readonly repoRoot: string;
  readonly toOid: string;
  readonly narrate: (event: ProjectProcessEvent) => void;
}

export interface ProcessProjectDeps {
  generate(repoRoot: string, options: GenerateOptions): Promise<GenerateResult>;
  listProjects(): Project[];
  repoKeyForRoot?(repoRoot: string): string;
  journal?: ProjectProcessJournal;
  runScout?(input: ProjectScoutRunInput): Promise<ProjectScoutQuestionnaire | null>;
  runKnowledge?(input: ProjectKnowledgeRunInput): Promise<KnowledgeSwarmOutcome>;
  loadKnowledge?(repoKey: string): KnowledgeSet | null;
}

interface LiveProjectProcess {
  readonly runId: string;
  readonly result: Promise<{ repos: ProcessedRepoSummary[]; run: ProjectProcessRun }>;
}

function memoryJournal(): ProjectProcessJournal {
  const records = new Map<string, ProjectProcessJournalRecord>();
  return {
    load: (repoKey) => records.get(repoKey) ?? null,
    save: (repoKey, record) => records.set(repoKey, structuredClone(record)),
  };
}

function repoPaths(project: Project): string[] {
  return project.includedRepoPaths && project.includedRepoPaths.length > 0
    ? project.includedRepoPaths
    : [project.openPath || project.path];
}

function freshRecord(
  runId: string,
  project: Project,
  paths: readonly string[],
): ProjectProcessJournalRecord {
  return {
    version: 1,
    runId,
    projectId: project.id,
    status: "queued",
    phase: "scout",
    repos: paths.map((path) => ({ repo: basename(path) || path, path })),
    failures: [],
    events: [],
  };
}

function sameRepos(record: ProjectProcessJournalRecord, paths: readonly string[]): boolean {
  return (
    record.repos.length === paths.length &&
    record.repos.every((checkpoint, index) => checkpoint.path === paths[index])
  );
}

function summariesOf(record: ProjectProcessJournalRecord): ProcessedRepoSummary[] {
  const failures = new Map(
    record.failures
      .filter((failure) => failure.summary !== undefined)
      .map((failure) => [failure.path, failure.summary]),
  );
  const summaries: ProcessedRepoSummary[] = [];
  for (const checkpoint of record.repos) {
    const summary = checkpoint.snapshot?.summary ?? failures.get(checkpoint.path);
    if (summary) summaries.push(summary);
  }
  return summaries;
}

function totalsOf(record: ProjectProcessJournalRecord) {
  const summaries = summariesOf(record);
  return {
    repos: summaries.length,
    files: summaries.reduce((total, summary) => total + (summary.files ?? 0), 0),
    scopes: record.repos.reduce(
      (total, checkpoint) => total + (checkpoint.snapshot?.scopes ?? 0),
      0,
    ),
    confirmed: record.repos.reduce(
      (total, checkpoint) => total + (checkpoint.knowledge?.confirmed ?? 0),
      0,
    ),
    rejected: record.repos.reduce(
      (total, checkpoint) => total + (checkpoint.knowledge?.rejected ?? 0),
      0,
    ),
  };
}

export function projectProcessRunFromRecord(
  record: ProjectProcessJournalRecord,
): ProjectProcessRun {
  const base = {
    id: record.runId,
    projectId: record.projectId,
    repos: summariesOf(record),
    scout: record.repos[0]?.scout ?? null,
  };
  switch (record.status) {
    case "queued":
      return { ...base, status: "queued", phase: "scout" };
    case "running":
      return {
        ...base,
        status: "running",
        phase: record.phase === "complete" ? "knowledge" : record.phase,
      };
    case "done":
      return { ...base, status: "done", phase: "complete", totals: totalsOf(record) };
    case "failed": {
      const failure = record.failures[0];
      return {
        ...base,
        status: "failed",
        phase: failure?.phase ?? (record.phase === "complete" ? "knowledge" : record.phase),
        reason:
          record.failures.map((entry) => `${entry.repo}: ${entry.reason}`).join("; ") ||
          "Project processing failed",
      };
    }
  }
}

function knowledgeCounts(set: KnowledgeSet): { confirmed: number; rejected: number } {
  return {
    confirmed: set.statements.filter((statement) => statement.status === "confirmed").length,
    rejected: set.statements.filter((statement) => statement.status === "rejected").length,
  };
}

const MAP_NOTE: Record<string, string> = {
  resolve: "Found the default branch",
  tree: "Scanned the working tree",
  workspace: "Mapped imports across scopes",
  conventions: "Read conventions, ownership, and tests",
  symbols: "Indexed symbols, references, and imports",
  build: "Built the structural map",
  verify: "Verified structural-map integrity",
  store: "Saved the structural map",
};

export function createProcessProject(deps: ProcessProjectDeps) {
  const journal = deps.journal ?? memoryJournal();
  const live = new Map<string, LiveProjectProcess>();

  async function execute(
    input: { projectId: string; commandId?: string },
    emit: (event: ProjectProcessEvent) => void,
  ): Promise<{ repos: ProcessedRepoSummary[]; run: ProjectProcessRun }> {
    const project = deps.listProjects().find((entry) => entry.id === input.projectId);
    const runId = input.commandId ?? commandIdFor(`project.process:${input.projectId}`);
    if (!project) {
      const run: ProjectProcessRun = {
        id: runId,
        projectId: input.projectId,
        status: "failed",
        phase: "scout",
        repos: [],
        scout: null,
        reason: "Project not found",
      };
      return { repos: [], run };
    }

    const paths = repoPaths(project);
    const primaryPath = project.openPath || project.path;
    const primaryRepoKey = deps.repoKeyForRoot?.(primaryPath) ?? primaryPath;
    const stored = journal.load(primaryRepoKey);
    let record =
      stored &&
      stored.runId === runId &&
      stored.projectId === project.id &&
      sameRepos(stored, paths)
        ? stored
        : freshRecord(runId, project, paths);

    for (const event of record.events) emit(event);
    if (record.status === "done") {
      const run = projectProcessRunFromRecord(record);
      return { repos: run.repos, run };
    }

    const save = (): void => journal.save(primaryRepoKey, record);
    const narrate = (event: ProjectProcessEvent): void => {
      record = { ...record, events: upsertProjectProcessEvent(record.events, event) };
      save();
      emit(event);
    };
    const setState = (
      status: ProjectProcessJournalRecord["status"],
      phase: ProjectProcessJournalRecord["phase"],
      detail?: string,
    ): void => {
      record = { ...record, status, phase };
      narrate({
        kind: "run-state",
        runId,
        projectId: project.id,
        status,
        phase,
        ...(detail ? { detail } : {}),
      });
    };
    const replaceRepo = (
      path: string,
      update: (
        checkpoint: ProjectProcessJournalRecord["repos"][number],
      ) => ProjectProcessJournalRecord["repos"][number],
    ): void => {
      record = {
        ...record,
        repos: record.repos.map((checkpoint) =>
          checkpoint.path === path ? update(checkpoint) : checkpoint,
        ),
      };
      save();
    };
    const fail = (failure: ProjectProcessFailure): void => {
      record = { ...record, failures: [...record.failures, failure] };
      save();
    };

    record = { ...record, failures: [] };
    const scoutPending = deps.runScout
      ? record.repos.some((checkpoint) => !checkpoint.scout)
      : false;
    if (scoutPending) {
      setState("running", "scout");
      for (const [index, checkpoint] of record.repos.entries()) {
        if (checkpoint.scout || !deps.runScout) continue;
        narrate({
          kind: "repo-start",
          repo: checkpoint.repo,
          index: index + 1,
          total: record.repos.length,
        });
        const repoKey = deps.repoKeyForRoot?.(checkpoint.path) ?? checkpoint.path;
        let questionnaire: ProjectScoutQuestionnaire | null;
        try {
          questionnaire = await deps.runScout({
            projectId: project.id,
            runId,
            repoKey,
            repoRoot: checkpoint.path,
            defaultBranch: project.primaryBranch,
            narrate,
          });
        } catch (error) {
          fail({
            repo: checkpoint.repo,
            path: checkpoint.path,
            phase: "scout",
            reason: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        if (!questionnaire) {
          fail({
            repo: checkpoint.repo,
            path: checkpoint.path,
            phase: "scout",
            reason: "the scout did not return persisted facts",
          });
          continue;
        }
        replaceRepo(checkpoint.path, (current) => ({ ...current, scout: questionnaire }));
      }
    }
    if (record.failures.some((failure) => failure.phase === "scout")) {
      setState("failed", "scout");
      const run = projectProcessRunFromRecord(record);
      return { repos: run.repos, run };
    }

    if (record.repos.some((checkpoint) => !checkpoint.snapshot)) setState("running", "map");
    for (const checkpoint of record.repos) {
      if (checkpoint.snapshot) continue;
      let active: { stage: string; note: string; detail?: string } | undefined;
      const finishActive = (): void => {
        if (!active) return;
        narrate({
          kind: "step",
          runId,
          repo: checkpoint.repo,
          phase: "map",
          step: active.stage,
          status: "done",
          note: MAP_NOTE[active.stage] ?? active.note,
          ...(active.detail ? { detail: active.detail } : {}),
        });
        active = undefined;
      };
      try {
        const result = await deps.generate(checkpoint.path, {
          explicitBaseRef: project.primaryBranch,
          onProgress: (progress) => {
            if (active?.stage === progress.stage) {
              active = { stage: progress.stage, note: progress.note, detail: progress.detail };
              if (progress.detail) finishActive();
              return;
            }
            finishActive();
            active = { stage: progress.stage, note: progress.note, detail: progress.detail };
            narrate({
              kind: "step",
              runId,
              repo: checkpoint.repo,
              phase: "map",
              step: progress.stage,
              status: "running",
              note: MAP_NOTE[progress.stage] ?? progress.note,
              ...(progress.detail ? { detail: progress.detail } : {}),
            });
          },
        });
        finishActive();
        const summary: ProcessedRepoSummary = {
          repo: checkpoint.repo,
          path: checkpoint.path,
          ok: true,
          files: result.fileCount,
          symbols: result.symbolCount,
          references: result.referenceCount,
          reusedSymbols: result.reusedSymbolShards,
          baseRef: result.manifest.baseRef,
        };
        replaceRepo(checkpoint.path, (current) => ({
          ...current,
          snapshot: {
            summary,
            baseOid: result.manifest.baseOid,
            scopes: result.scopeCount,
          },
        }));
      } catch (error) {
        finishActive();
        const reason = error instanceof Error ? error.message : String(error);
        const summary: ProcessedRepoSummary = {
          repo: checkpoint.repo,
          path: checkpoint.path,
          ok: false,
          error: reason,
        };
        fail({ repo: checkpoint.repo, path: checkpoint.path, phase: "map", reason, summary });
        narrate({ kind: "repo-error", repo: checkpoint.repo, message: reason });
      }
    }

    if (record.repos.some((checkpoint) => checkpoint.snapshot && !checkpoint.knowledge))
      setState("running", "knowledge");
    for (const checkpoint of record.repos) {
      const current = record.repos.find((candidate) => candidate.path === checkpoint.path);
      if (!current?.snapshot || current.knowledge) continue;
      if (!deps.runKnowledge) {
        replaceRepo(checkpoint.path, (repo) => ({
          ...repo,
          knowledge: { confirmed: 0, rejected: 0 },
        }));
        narrate({
          kind: "repo-done",
          repo: checkpoint.repo,
          summary: current.snapshot.summary,
          artifact: { kind: "project", projectId: project.id },
        });
        continue;
      }
      const repoKey = deps.repoKeyForRoot?.(checkpoint.path) ?? checkpoint.path;
      let outcome: KnowledgeSwarmOutcome;
      try {
        outcome = await deps.runKnowledge({
          projectId: project.id,
          runId,
          repoKey,
          repoRoot: checkpoint.path,
          toOid: current.snapshot.baseOid,
          narrate,
        });
      } catch (error) {
        fail({
          repo: checkpoint.repo,
          path: checkpoint.path,
          phase: "knowledge",
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      let counts: { confirmed: number; rejected: number } | undefined;
      if (outcome.status === "ok") {
        counts = knowledgeCounts(outcome.set);
      } else if (outcome.status === "skipped") {
        const storedKnowledge = deps.loadKnowledge?.(repoKey) ?? null;
        if (storedKnowledge) counts = knowledgeCounts(storedKnowledge);
      } else {
        fail({
          repo: checkpoint.repo,
          path: checkpoint.path,
          phase: "knowledge",
          reason: outcome.reason,
        });
        continue;
      }
      if (counts) {
        replaceRepo(checkpoint.path, (repo) => ({ ...repo, knowledge: counts }));
        const latest = record.repos.find((candidate) => candidate.path === checkpoint.path);
        if (latest?.snapshot) {
          narrate({
            kind: "repo-done",
            repo: checkpoint.repo,
            summary: latest.snapshot.summary,
            artifact: { kind: "project", projectId: project.id },
          });
        }
      } else {
        fail({
          repo: checkpoint.repo,
          path: checkpoint.path,
          phase: "knowledge",
          reason: "knowledge was skipped but no current set could be read",
        });
      }
    }

    if (record.failures.length > 0) {
      const phase = record.failures.some((failure) => failure.phase === "knowledge")
        ? "knowledge"
        : "map";
      setState("failed", phase);
    } else {
      setState("done", "complete");
    }
    const run = projectProcessRunFromRecord(record);
    return { repos: run.repos, run };
  }

  return function processProject(
    input: { projectId: string; commandId?: string },
    emit: (event: ProjectProcessEvent) => void,
  ): Promise<{ repos: ProcessedRepoSummary[]; run: ProjectProcessRun }> {
    const runId = input.commandId ?? commandIdFor(`project.process:${input.projectId}`);
    const existing = live.get(input.projectId);
    if (existing) {
      if (existing.runId !== runId) {
        return Promise.reject(new Error("The project is already processing under another run"));
      }
      return existing.result;
    }
    const result = execute({ ...input, commandId: runId }, emit).finally(() => {
      const current = live.get(input.projectId);
      if (current?.runId === runId) live.delete(input.projectId);
    });
    live.set(input.projectId, { runId, result });
    return result;
  };
}
