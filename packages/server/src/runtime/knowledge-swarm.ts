import { basename } from "node:path";
import {
  KnowledgeStore,
  type KnowledgeSwarmOutcome,
  type KnowledgeSwarmProgress,
  ProjectContextReader,
  type ProjectSnapshotStore,
  runKnowledgeSwarmForRepo,
} from "@rennet/adapters";
import type { CodexExecutor, HarnessPort } from "@rennet/core";
import type { ProjectProcessEvent } from "@rennet/protocol";

/**
 * The knowledge-swarm SCHEDULER (#460, B06 cluster 5 / reconciliation 3): the
 * `server/runtime/` home the packet names. One entry point covers both triggers
 * — the initial run after a project's snapshot is built and the partition-routed
 * delta on a baseline advance. The swarm derives its own mode from the stored
 * prior set's identity (current ⇒ skip, older ⇒ delta from `prior.baseOid`,
 * absent/foreign-generator ⇒ full run). Progress rides the
 * EXISTING `ProjectProcessEvent` push (the `knowledge` stage): one line per
 * partition state change (queued / running / statement counts) and the verify
 * seat as its own line — no new channel.
 */

export interface KnowledgeSwarmRuntimeDeps {
  readonly store: ProjectSnapshotStore;
  /** The locus-aware Claude port probe (null when no `claude` resolves). */
  readonly resolveClaudePort: (repoRoot: string) => Promise<HarnessPort | null>;
  /** The locus-aware codex utility executor probe (null when no `codex` resolves). */
  readonly resolveCodexExecutor: (repoRoot: string) => Promise<CodexExecutor | null>;
  /**
   * The existing progress push (same channel the processing screen renders),
   * scoped to the project whose pass is running — the channel used to be
   * process-global, so one project's swarm narrated onto every project's screen.
   */
  readonly narrate: (projectId: string, event: ProjectProcessEvent) => void;
}

export interface KnowledgeSwarmRunInput {
  /** The project this run narrates under. */
  readonly projectId: string;
  readonly repoKey: string;
  readonly repoRoot: string;
  /** The base OID the snapshot is fresh at (the run's target). */
  readonly toOid: string;
}

export interface KnowledgeSwarmRuntime {
  runForRepo(input: KnowledgeSwarmRunInput): Promise<KnowledgeSwarmOutcome>;
}

/** Render one swarm progress event as an honest `knowledge`-stage narration line. */
export function knowledgeStageLine(
  repo: string,
  event: KnowledgeSwarmProgress,
): ProjectProcessEvent {
  if (event.kind === "verify") {
    const note =
      event.status === "running"
        ? "Verifying knowledge hypotheses"
        : event.status === "done"
          ? "Knowledge verified"
          : "Knowledge verification failed";
    const detail =
      event.status === "done"
        ? `${event.confirmed ?? 0} confirmed, ${event.rejected ?? 0} rejected, ${event.crossCutting ?? 0} cross-cutting`
        : undefined;
    return {
      kind: "stage",
      repo,
      stage: "knowledge",
      note,
      ...(detail === undefined ? {} : { detail }),
    };
  }
  // `reused` is narrated as what it is: the batch was answered from the journal
  // (#581) and cost no model turn. Calling that "done" would report spend that
  // did not happen, which is the same class of lie as reporting a failure for a
  // worker that never ran.
  const verb =
    event.status === "queued"
      ? "queued"
      : event.status === "running"
        ? "running"
        : event.status === "done"
          ? "done"
          : event.status === "reused"
            ? "reused from the journal"
            : "failed";
  return {
    kind: "stage",
    repo,
    stage: "knowledge",
    note: `Knowledge worker ${event.index}/${event.total} ${verb}`,
    detail:
      event.statements === undefined
        ? event.sliceId
        : `${event.sliceId}: ${event.statements} statements`,
  };
}

/**
 * The honest end-of-pass line for a non-`ok` outcome. Every non-`ok` variant of
 * `KnowledgeSwarmOutcome` carries a `reason`; dropping it (the pass used to be
 * collapsed to a boolean at the composition root) is why a whole run could die
 * on "Prompt is too long" with nothing said anywhere. `ok` needs no line — the
 * verify progress event already reported its counts.
 */
export function knowledgeOutcomeLine(
  repo: string,
  outcome: KnowledgeSwarmOutcome,
): ProjectProcessEvent | undefined {
  if (outcome.status === "ok") return undefined;
  const note =
    outcome.status === "skipped"
      ? "Knowledge pass skipped"
      : outcome.status === "snapshot-unavailable"
        ? "Knowledge pass has no fresh snapshot"
        : "Knowledge pass failed";
  return { kind: "stage", repo, stage: "knowledge", note, detail: outcome.reason };
}

/** Build the scheduler over the composition root's stores and harness probes. */
export function createKnowledgeSwarmRuntime(
  deps: KnowledgeSwarmRuntimeDeps,
): KnowledgeSwarmRuntime {
  return {
    async runForRepo(input: KnowledgeSwarmRunInput): Promise<KnowledgeSwarmOutcome> {
      const repoLabel = basename(input.repoRoot);
      const narrated = (outcome: KnowledgeSwarmOutcome): KnowledgeSwarmOutcome => {
        const line = knowledgeOutcomeLine(repoLabel, outcome);
        if (line) deps.narrate(input.projectId, line);
        return outcome;
      };
      // Every THROWN failure becomes the same typed, narrated outcome the
      // resolved ones get. The runtime is the one place every swarm path routes
      // through, and the throws are real: a harness probe can reject, and a
      // Claude seat's `createSession` runs BEFORE the adapter turn's own `try`.
      // Left uncaught it escaped to the rehydration loop's `onError`, which
      // production wires to `console.error` — the user saw nothing, while the
      // typed path narrated. Same failure, two visibilities, is the bug.
      try {
        const [claudePort, codexExecutor] = await Promise.all([
          deps.resolveClaudePort(input.repoRoot),
          deps.resolveCodexExecutor(input.repoRoot),
        ]);
        if (!claudePort && !codexExecutor) {
          return narrated({
            status: "failed",
            reason: "no harness is available to run the knowledge swarm",
          });
        }
        return narrated(
          await runKnowledgeSwarmForRepo({
            reader: new ProjectContextReader(deps.store),
            knowledgeStore: new KnowledgeStore(deps.store),
            claudePort,
            codexExecutor,
            repoKey: input.repoKey,
            repoRoot: input.repoRoot,
            baseOid: input.toOid,
            onProgress: (event) =>
              deps.narrate(input.projectId, knowledgeStageLine(repoLabel, event)),
          }),
        );
      } catch (error) {
        return narrated({
          status: "failed",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
