import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import {
  copyDetectedLogo,
  councilSeatTurn,
  detectProjectLogo,
  type GitExec,
  PROJECT_SCOUT_CONTEXT_PREFIX,
  PROJECT_SCOUT_SCHEMA,
  type ProjectSnapshotStore,
  runProjectScout,
  type ScoutFact,
  type ScoutResult,
  saveScoutFacts,
} from "@rennet/adapters";
import type {
  CodexExecutor,
  CouncilOverrideReader,
  HarnessPort,
  HarnessTurnResult,
} from "@rennet/core";
import { councilContextFor } from "@rennet/core";
import type {
  CouncilHarnessId,
  ProjectProcessEvent,
  ProjectScoutAnswer,
  ProjectScoutQuestionnaire,
} from "@rennet/protocol";
import { purgeSessionContext, writeSessionContext } from "../context-files";

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
  /**
   * The reviewer's own role overrides, read per dispatch (#876). Absent means the council's
   * own tables decide, which is what every site did before the overrides were wired.
   */
  readonly councilOverrides?: CouncilOverrideReader;
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
  /**
   * Re-run ONLY the logo half for one repo, and copy the pick into its project dir (#900) —
   * Identity's "Detect again". It routes through the SAME council seat `runForRepo` does, so
   * there is one harness path for the scout; it just asks a smaller question. `null` means no
   * candidate survived, and any previous copy is left where it is.
   */
  detectLogoForRepo(input: {
    readonly repoKey: string;
    readonly repoRoot: string;
  }): Promise<ScoutFact | null>;
}

const ANSWER_HINT: Record<ProjectScoutAnswer["key"], string> = {
  trackerKind: "referenced tickets feed review context",
  defaultBranch: "the structural map reads this branch",
  // NOT where Rennet works: a session binds to the checkout that already has its branch
  // out, or to a worktree Rennet makes under `~/.rennet/worktrees`, and a coding round is
  // a turn in that workspace (#812). This fact is the repo's OWN convention, read off
  // `git worktree list`.
  worktreeBaseDir: "where this repository's own worktrees live",
  gateCommand: "a coding round asks its worker to run this before committing",
  logoPath:
    "the logo Rennet copies in and shows as this project's mark; change it in Settings → Projects → Identity",
};

const ANSWER_OPTIONS: Partial<Record<ProjectScoutAnswer["key"], readonly string[]>> = {
  trackerKind: ["github", "jira", "linear", "none"],
};

/** Project the exact stored scout facts into the renderer-safe questionnaire. */
export function scoutQuestionnaire(repo: string, result: ScoutResult): ProjectScoutQuestionnaire {
  // `worktreeBaseDir` is DELIBERATELY absent (#812). It is still scouted and still stored —
  // it is an honest fact about the repository — but it steers nothing: a session binds to
  // the checkout that already has its branch out, or to a worktree under Rennet's own data
  // directory, and no setting moves that. Asking the reviewer to confirm it put a field on
  // screen that changes nothing, and with no sibling worktree to detect it was a blank one.
  const keys: readonly ProjectScoutAnswer["key"][] = [
    "trackerKind",
    "defaultBranch",
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
  /**
   * The `project-scout` council seat for one repo, or null when no harness is installed.
   * ONE resolution shared by the full run and by logo-only re-detection, so both reach the
   * single `port.createSession` the council owns and neither grows a second harness path.
   */
  const resolveSeat = async (
    repoRoot: string,
  ): Promise<((prompt: string, attempt: number) => Promise<HarnessTurnResult>) | null> => {
    // Each resolver failure is isolated to its own harness: a rejected
    // discovery must not skip the deterministic pass (which needs no model
    // at all) — it just narrows availability.
    const [claudePort, codexExecutor] = await Promise.all([
      deps.resolveClaudePort(repoRoot).catch(() => null),
      deps.resolveCodexExecutor(repoRoot).catch(() => null),
    ]);
    const installed: CouncilHarnessId[] = [];
    if (claudePort) installed.push("claude-code");
    if (codexExecutor) installed.push("codex");
    if (installed.length === 0) return null;
    const seat = councilSeatTurn(
      "project-scout",
      PROJECT_SCOUT_SCHEMA,
      { claudePort, codexExecutor, repoRoot, label: "project.scout" },
      councilContextFor(installed, deps.councilOverrides),
    );
    return "runTurn" in seat ? seat.runTurn : null;
  };

  /** Copy the fact's file into the project dir, so the mark is bytes Rennet owns (ADR 0004).
   *  The repo comes from the FACT, never from the project — a workspace maps many repos to
   *  one identity and the project cannot say which one this path is relative to. */
  const copyMark = (repoKey: string, fact: ScoutFact | undefined): void => {
    if (fact?.provenance !== "detected" || fact.value === "") return;
    // A fact with no recorded root predates #900 and cannot be resolved to a repository
    // here without guessing one. Copying nothing is the honest answer; "Detect again"
    // recomputes it with a root attached.
    if (!fact.repoRoot) return;
    copyDetectedLogo(deps.store, repoKey, fact.repoRoot, fact.value);
  };

  return {
    async detectLogoForRepo(input): Promise<ScoutFact | null> {
      const runTurn = await resolveSeat(input.repoRoot).catch(() => null);
      const fact = await detectProjectLogo({ repoRoot: input.repoRoot, runTurn });
      if (fact) copyMark(input.repoKey, fact);
      return fact;
    },

    async runForRepo(input: ProjectScoutRunInput): Promise<ScoutResult | null> {
      const repoLabel = basename(input.repoRoot);
      const narrate = (event: ProjectProcessEvent): void => {
        if (input.narrate) input.narrate(event);
        else deps.narrate?.(input.projectId, event);
      };
      try {
        const runTurn = await resolveSeat(input.repoRoot);
        // The scout runs for a PROJECT, before any session exists, so its context sits in
        // the repo it is scouting under an id of its OWN — one per run, and purged when
        // the run returns. A fixed id was never a session id, so every daemon start read
        // the directory as an orphan, and two scouts on one root raced purge-then-write:
        // the second wiped the file the first one's seat was reading (review finding 5).
        const contextId = `${PROJECT_SCOUT_CONTEXT_PREFIX}-${randomUUID()}`;
        let result: ScoutResult;
        try {
          result = await runProjectScout({
            repoRoot: input.repoRoot,
            git: deps.gitForRepo(input.repoRoot),
            ...(input.defaultBranch ? { knownDefaultBranch: input.defaultBranch } : {}),
            runTurn,
            writeContext: (files) => writeSessionContext(input.repoRoot, contextId, files),
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
        } finally {
          // There is no archive to purge a project-scoped directory at, so the run owns
          // its own end — including the failed run, whose files nothing else would remove.
          purgeSessionContext(input.repoRoot, contextId);
        }
        saveScoutFacts(deps.store, input.repoKey, result);
        // A project add copies its mark with no user action (#900): the scout's detected
        // logo becomes bytes in the project dir, which is what the `mark` ladder's
        // `detected` rung is offered on.
        copyMark(input.repoKey, result.facts.logoPath);
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
            stage: "scout",
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
                stage: "scout",
                note: "Project scout failed",
                detail,
              },
        );
        return null;
      }
    },
  };
}
