import { basename } from "node:path";
import type { GenerateOptions, GenerateResult } from "@rennet/adapters";
import type { ProcessedRepoSummary, Project, ProjectProcessEvent } from "@rennet/protocol";

/**
 * The initial context dump (issue #29, wireframe #2): build every included repo's
 * ProjectSnapshot, streaming the real generator stages as live narration. Extracted
 * from the electron main so it is unit-testable without an Electron runtime — the
 * generator and the project lookup are injected.
 *
 * Two properties the wiring must hold, both caught by dedicated regressions:
 *  - each repo is built at the project's CONFIRMED primary branch (`explicitBaseRef`),
 *    not whatever the repo's local default happens to be;
 *  - the summary reports the generator's REAL totals (files / declared symbols /
 *    identifier occurrences), never shard-pointer array lengths.
 *
 * Soft per-repo failure is carried in the summary, never thrown, so one bad repo
 * cannot abort a workspace's remaining repos. Pure over git — no gate, no model spend.
 */
export interface ProcessProjectDeps {
  /** Build (and persist) one repo's snapshot at the given options. */
  generate(repoRoot: string, options: GenerateOptions): Promise<GenerateResult>;
  /** The persisted projects, for resolving the addressed project + its included repos. */
  listProjects(): Project[];
}

export function createProcessProject(deps: ProcessProjectDeps) {
  return async function processProject(
    input: { projectId: string },
    emit: (event: ProjectProcessEvent) => void,
  ): Promise<{ repos: ProcessedRepoSummary[] }> {
    const project = deps.listProjects().find((entry) => entry.id === input.projectId);
    if (!project) return { repos: [] };

    const repoPaths =
      project.includedRepoPaths && project.includedRepoPaths.length > 0
        ? project.includedRepoPaths
        : [project.openPath || project.path];

    const repos: ProcessedRepoSummary[] = [];
    for (const [index, path] of repoPaths.entries()) {
      const repo = basename(path) || path;
      emit({ kind: "repo-start", repo, index: index + 1, total: repoPaths.length });
      try {
        const result = await deps.generate(path, {
          // Build at the branch the user CONFIRMED in the worktree-config step, not
          // the repo's local default — otherwise the whole context dump is taken at
          // the wrong ref.
          explicitBaseRef: project.primaryBranch,
          onProgress: (progress) =>
            emit({
              kind: "stage",
              repo,
              stage: progress.stage,
              note: progress.note,
              detail: progress.detail,
            }),
        });
        const summary: ProcessedRepoSummary = {
          repo,
          path,
          ok: true,
          files: result.fileCount,
          symbols: result.symbolCount,
          references: result.referenceCount,
          reusedSymbols: result.reusedSymbolShards,
          baseRef: result.manifest.baseRef,
        };
        repos.push(summary);
        emit({ kind: "repo-done", repo, summary });
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        repos.push({ repo, path, ok: false, error: message });
        emit({ kind: "repo-error", repo, message });
      }
    }
    return { repos };
  };
}
