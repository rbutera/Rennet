import { basename } from "node:path";
import type { GenerateOptions, GenerateResult } from "@rennet/adapters";
import {
  type BenchmarkRun,
  commandIdFor,
  type ProcessedRepoSummary,
  type Project,
  type ProjectProcessEvent,
  type ProjectProcessRun,
  type ProjectScoutQuestionnaire,
} from "@rennet/protocol";
import { createStageTimer, isMapBenchmarkStage } from "./benchmark-recorder";
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

export interface ProcessProjectDeps {
  generate(repoRoot: string, options: GenerateOptions): Promise<GenerateResult>;
  listProjects(): Project[];
  repoKeyForRoot?(repoRoot: string): string;
  journal?: ProjectProcessJournal;
  runScout?(input: ProjectScoutRunInput): Promise<ProjectScoutQuestionnaire | null>;
  /**
   * Archive one repo's Repo Map benchmark record (#731 9.2). The stages come from the
   * generator's OWN progress stream — the boundaries it already narrates to the
   * processing screen — so instrumentation adds no new measurement points and the whole
   * build is deterministic end to end (there are no model-backed layers left to time).
   * Absent ⇒ no archive, identical processing.
   */
  recordBenchmark?(run: BenchmarkRun): void;
  /** The wall clock, injectable so a test can script the stage timings. */
  now?(): number;
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
        phase: record.phase === "complete" || record.phase === "knowledge" ? "map" : record.phase,
      };
    case "done":
      return { ...base, status: "done", phase: "complete", totals: totalsOf(record) };
    case "failed": {
      const failure = record.failures[0];
      return {
        ...base,
        status: "failed",
        phase:
          (failure?.phase === "knowledge" ? "map" : failure?.phase) ??
          (record.phase === "complete" || record.phase === "knowledge" ? "map" : record.phase),
        reason:
          record.failures.map((entry) => `${entry.repo}: ${entry.reason}`).join("; ") ||
          "Project processing failed",
      };
    }
  }
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
    // One timer per repo, opened at that repo's scout and closed when its map build ends.
    // The `total` stage is the SUM of that repo's own stage durations (see
    // createStageTimer) — never a wall-clock span, which would absorb sibling repos'
    // work between the interleaved scout and map passes. Keyed by repo path because the
    // scout loop and the map loop are separate passes over the same repos.
    const clock = deps.now ?? Date.now;
    const timers = new Map<string, ReturnType<typeof createStageTimer>>();
    const timerFor = (path: string) => {
      const existing = timers.get(path);
      if (existing !== undefined) return existing;
      const created = createStageTimer(clock);
      timers.set(path, created);
      return created;
    };
    /**
     * Archive one repository's map attempt. Shared by every exit — a failed scout, a
     * sibling's failed scout, a map that died before its first progress event, and a build
     * that finished — because each of those used to leave NO record at all. A scout that
     * threw returned before anything was archived, and a build that died pre-stage was
     * dropped for having no `total`, so the archive's failure rate was a rate over the
     * runs that got far enough to be counted.
     *
     * `startedAtMs` falls back to the caller's stamp when no stage was measured; the run's
     * `durationMs` is the sum of THIS repo's stages (see `createStageTimer`), never a wall
     * clock across the passes, because the scout pass and the map pass are separated by
     * every sibling repository's work.
     */
    const archiveMapRun = (
      checkpoint: ProjectProcessJournalRecord["repos"][number],
      timer: ReturnType<typeof createStageTimer>,
      outcome: "complete" | "failed" | "aborted",
      options: { readonly failure?: string; readonly revision?: string; readonly from?: number },
    ): void => {
      const stages = timer.finish();
      const total = stages.find((stage) => stage.stage === "total");
      const startedAtMs = total?.startedAtMs ?? options.from ?? Math.floor(clock());
      deps.recordBenchmark?.({
        version: 1,
        id: `${checkpoint.path}:${startedAtMs}`,
        kind: "repo-map",
        producer: "daemon",
        subject: {
          label: checkpoint.repo,
          repoKey: deps.repoKeyForRoot?.(checkpoint.path) ?? checkpoint.path,
          ...(options.revision === undefined ? {} : { revision: options.revision }),
        },
        startedAtMs,
        durationMs: total?.durationMs ?? 0,
        outcome,
        ...(options.failure === undefined ? {} : { failure: options.failure }),
        stages,
      });
    };
    /** Why a repo's scout failed, keyed by path — the scout loop records nothing itself,
     *  because a scout failure ends the whole project process a few lines later and the
     *  archive is taken there for every repository at once. */
    const scoutFailures = new Map<string, string>();
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
        const scoutTimer = timerFor(checkpoint.path);
        scoutTimer.enter("scout");
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
          const reason = error instanceof Error ? error.message : String(error);
          scoutFailures.set(checkpoint.path, reason);
          fail({
            repo: checkpoint.repo,
            path: checkpoint.path,
            phase: "scout",
            reason,
          });
          continue;
        } finally {
          // Closed here, not after the loop body: a scout left open would keep running
          // across the NEXT repo's scout and hand the first repo the second one's time.
          scoutTimer.leave();
        }
        if (!questionnaire) {
          scoutFailures.set(checkpoint.path, "the scout did not return persisted facts");
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
      // The project ends here, so every timer that opened is a terminal measurement. The
      // repos that failed scouting say so; the ones that scouted cleanly were ABORTED by a
      // sibling's failure and never reached a map — recording nothing for either meant the
      // archive only ever held the repositories that got as far as a map build.
      for (const checkpoint of record.repos) {
        const timer = timers.get(checkpoint.path);
        if (timer === undefined) continue;
        const reason = scoutFailures.get(checkpoint.path);
        archiveMapRun(checkpoint, timer, reason === undefined ? "aborted" : "failed", {
          failure:
            reason ?? "another repository's scout failed, so this project process ended first",
        });
      }
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
      const timer = timerFor(checkpoint.path);
      // The archive is taken from a `finally`, so a build that DIED is recorded as a
      // failed run carrying the stages it reached. A record that only survived success
      // would make the slowest builds — the ones that fall over — invisible. `mapFrom`
      // is the fallback origin for a build that died before its FIRST progress event and
      // therefore has no stage to take a start from; such a run used to be dropped.
      const mapFrom = Math.floor(clock());
      let mapOutcome: "complete" | "failed" = "complete";
      let mapFailure: string | undefined;
      let mapRevision: string | undefined;
      try {
        const result = await deps.generate(checkpoint.path, {
          explicitBaseRef: project.primaryBranch,
          onProgress: (progress) => {
            if (isMapBenchmarkStage(progress.stage)) timer.enter(progress.stage);
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
        mapRevision = result.manifest.baseOid;
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
        mapOutcome = "failed";
        mapFailure = reason;
        const summary: ProcessedRepoSummary = {
          repo: checkpoint.repo,
          path: checkpoint.path,
          ok: false,
          error: reason,
        };
        fail({ repo: checkpoint.repo, path: checkpoint.path, phase: "map", reason, summary });
        narrate({ kind: "repo-error", repo: checkpoint.repo, message: reason });
      } finally {
        // Recorded even with NO stage at all. A build that died before its first progress
        // line used to be dropped for having no `total`, on the reasoning that a
        // zero-length run reads as an instantaneous map — but the stage list is empty and
        // says so, while the missing record made the earliest failures invisible, which is
        // the failure mode that actually matters.
        archiveMapRun(checkpoint, timer, mapOutcome, {
          from: mapFrom,
          ...(mapFailure === undefined ? {} : { failure: mapFailure }),
          ...(mapRevision === undefined ? {} : { revision: mapRevision }),
        });
      }
    }

    // Every snapshotted repo is done once its map lands — there is no post-map
    // model phase. The artifact-stamped repo-done is what flips the UI row.
    for (const checkpoint of record.repos) {
      const current = record.repos.find((candidate) => candidate.path === checkpoint.path);
      if (!current?.snapshot) continue;
      narrate({
        kind: "repo-done",
        repo: checkpoint.repo,
        summary: current.snapshot.summary,
        artifact: { kind: "project", projectId: project.id },
      });
    }

    if (record.failures.length > 0) {
      setState("failed", "map");
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
