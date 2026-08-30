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
import type {
  CouncilHarnessId,
  ProjectProcessEvent,
  ProjectScoutAnswer,
  ProjectScoutQuestionnaire,
} from "@rennet/protocol";

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
  /** Default background channel, overridden by the foreground project coordinator. */
  readonly narrate?: (projectId: string, event: ProjectProcessEvent) => void;
}

export interface ProjectScoutRunInput {
  /** The project this run narrates under. */
  readonly projectId: string;
  readonly repoKey: string;
  readonly repoRoot: string;
  readonly defaultBranch?: string;
  readonly runId?: string;
  readonly narrate?: (event: ProjectProcessEvent) => void;
}

export interface ProjectScoutRuntime {
  runForRepo(input: ProjectScoutRunInput): Promise<ScoutResult | null>;
}

const ANSWER_HINT: Record<ProjectScoutAnswer["key"], string> = {
  trackerKind: "referenced tickets feed review context",
  defaultBranch: "the structural map reads this branch",
  worktreeBaseDir: "coding rounds create worktrees here",
  gateCommand: "coding rounds run this before handoff",
  logoPath:
    "cosmetic repository evidence only; choose the sidebar mark in Settings → Projects → Identity",
};

const ANSWER_OPTIONS: Partial<Record<ProjectScoutAnswer["key"], readonly string[]>> = {
  trackerKind: ["github", "jira", "linear", "none"],
};

/** Project the exact stored scout facts into the renderer-safe questionnaire. */
export function scoutQuestionnaire(repo: string, result: ScoutResult): ProjectScoutQuestionnaire {
  const keys: readonly ProjectScoutAnswer["key"][] = [
    "trackerKind",
    "defaultBranch",
    "worktreeBaseDir",
    "gateCommand",
    "logoPath",
  ];
  const answers = keys.map((key): ProjectScoutAnswer => {
    const fact = result.facts[key];
    if (!fact) throw new Error(`Project scout did not produce ${key}`);
    const options = ANSWER_OPTIONS[key];
    return {
      key,
      value: fact.value,
      provenance: fact.provenance,
      source: fact.source,
      hint: ANSWER_HINT[key],
      ...(options ? { options: [...options] } : {}),
    };
  });
  const detected = answers.filter((answer) => answer.provenance === "detected").length;
  return { repo, answers, detected, guessed: answers.length - detected };
}

export function createProjectScoutRuntime(deps: ProjectScoutRuntimeDeps): ProjectScoutRuntime {
  return {
    async runForRepo(input: ProjectScoutRunInput): Promise<ScoutResult | null> {
      const repoLabel = basename(input.repoRoot);
      const narrate = (event: ProjectProcessEvent): void => {
        if (input.narrate) input.narrate(event);
        else deps.narrate?.(input.projectId, event);
      };
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
          ...(input.defaultBranch ? { knownDefaultBranch: input.defaultBranch } : {}),
          runTurn: seat !== null && "runTurn" in seat ? seat.runTurn : null,
          onProgress: (progress) => {
            if (!input.runId) return;
            const line =
              progress.step === "remotes"
                ? "Read the git remotes"
                : progress.step === "config"
                  ? "Checked tracker markers and CI config"
                  : "Scout reading README, CONTRIBUTING, and agent files";
            narrate({
              kind: "step",
              runId: input.runId,
              repo: repoLabel,
              phase: "scout",
              step: progress.step,
              status: progress.status,
              note: line,
              ...(progress.detail ? { detail: progress.detail } : {}),
            });
          },
        });
        saveScoutFacts(deps.store, input.repoKey, result);
        const questionnaire = scoutQuestionnaire(repoLabel, result);
        if (input.runId) {
          narrate({
            kind: "step",
            runId: input.runId,
            repo: repoLabel,
            phase: "scout",
            step: "returned",
            status: "done",
            note: "Scout returned",
            detail: `${questionnaire.detected} detected, ${questionnaire.guessed} guessed`,
          });
          narrate({
            kind: "scout-ready",
            runId: input.runId,
            repo: repoLabel,
            questionnaire,
          });
        } else {
          narrate({
            kind: "stage",
            repo: repoLabel,
            stage: "knowledge",
            note: "Project scout complete",
            detail: `${questionnaire.detected} detected, ${questionnaire.guessed} guessed`,
          });
        }
        return result;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        narrate(
          input.runId
            ? {
                kind: "step",
                runId: input.runId,
                repo: repoLabel,
                phase: "scout",
                step: "returned",
                status: "failed",
                note: "Project scout failed",
                detail,
              }
            : {
                kind: "stage",
                repo: repoLabel,
                stage: "knowledge",
                note: "Project scout failed",
                detail,
              },
        );
        return null;
      }
    },
  };
}
