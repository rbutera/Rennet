import { basename } from "node:path";
import {
  councilSeatTurn,
  type GitExec,
  PROJECT_SCOUT_SCHEMA,
  type ProjectSnapshotStore,
  runProjectScout,
  type ScoutResult,
  saveScoutFacts,
} from "@rennet/adapters";
import type { CodexExecutor, HarnessPort } from "@rennet/core";
import type { CouncilHarnessId, ProjectProcessEvent } from "@rennet/protocol";

/**
 * The project-scout SCHEDULER (#461 §4, B7 cluster 4): runs at project add and
 * on every re-process (task 4.3 — re-runnable by construction: determinism
 * recomputes, the seat never overwrites a detected value, guidance seeds only
 * into an absent catalogue). The seat routes through the council
 * (`project-scout`, heavy tier); with no harness available the deterministic
 * pass still runs and persists — the scout never blocks on a model.
 *
 * Results persist to the project's `scout.json` (the detected-layer store,
 * proposal amendment 9); missing-config facts ride along for B8's in-chat ask.
 * Progress is one honest line on the EXISTING processing push.
 */

export interface ProjectScoutRuntimeDeps {
  readonly store: ProjectSnapshotStore;
  /** The locus-aware git runner the composition root already owns. */
  readonly gitForRepo: (repoRoot: string) => GitExec;
  readonly resolveClaudePort: (repoRoot: string) => Promise<HarnessPort | null>;
  readonly resolveCodexExecutor: (repoRoot: string) => Promise<CodexExecutor | null>;
  readonly narrate: (event: ProjectProcessEvent) => void;
}

export interface ProjectScoutRunInput {
  readonly repoKey: string;
  readonly repoRoot: string;
}

export interface ProjectScoutRuntime {
  runForRepo(input: ProjectScoutRunInput): Promise<ScoutResult | null>;
}

export function createProjectScoutRuntime(deps: ProjectScoutRuntimeDeps): ProjectScoutRuntime {
  return {
    async runForRepo(input: ProjectScoutRunInput): Promise<ScoutResult | null> {
      const repoLabel = basename(input.repoRoot);
      try {
        // Each resolver failure is isolated to its own harness: a rejected
        // discovery must not skip the deterministic pass (which needs no model
        // at all) — it just narrows availability.
        const [claudePort, codexExecutor] = await Promise.all([
          deps.resolveClaudePort(input.repoRoot).catch(() => null),
          deps.resolveCodexExecutor(input.repoRoot).catch(() => null),
        ]);
        const installed: CouncilHarnessId[] = [];
        if (claudePort) installed.push("claude-code");
        if (codexExecutor) installed.push("codex");
        const seat =
          installed.length === 0
            ? null
            : councilSeatTurn(
                "project-scout",
                PROJECT_SCOUT_SCHEMA,
                {
                  claudePort,
                  codexExecutor,
                  repoRoot: input.repoRoot,
                  label: "project.scout",
                },
                { availability: { installed } },
              );
        const result = await runProjectScout({
          repoRoot: input.repoRoot,
          git: deps.gitForRepo(input.repoRoot),
          runTurn: seat !== null && "runTurn" in seat ? seat.runTurn : null,
        });
        saveScoutFacts(deps.store, input.repoKey, result);
        const detected = Object.keys(result.facts).length;
        deps.narrate({
          kind: "stage",
          repo: repoLabel,
          stage: "knowledge",
          note: "Project scout complete",
          detail: `${detected} facts, ${result.guidanceSeeded} guidance rules seeded, ${result.missingConfig.length} config asks`,
        });
        return result;
      } catch (error) {
        // The scout is fire-and-forget garnish on processing: a failure narrates
        // and returns null, never breaks the project add.
        deps.narrate({
          kind: "stage",
          repo: repoLabel,
          stage: "knowledge",
          note: "Project scout failed",
          detail: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
  };
}
