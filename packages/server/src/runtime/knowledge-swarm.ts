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
  /** The existing progress push (same channel the processing screen renders). */
  readonly narrate: (event: ProjectProcessEvent) => void;
}

export interface KnowledgeSwarmRunInput {
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
  const verb =
    event.status === "queued"
      ? "queued"
      : event.status === "running"
        ? "running"
        : event.status === "done"
          ? "done"
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

/** Build the scheduler over the composition root's stores and harness probes. */
export function createKnowledgeSwarmRuntime(
  deps: KnowledgeSwarmRuntimeDeps,
): KnowledgeSwarmRuntime {
  return {
    async runForRepo(input: KnowledgeSwarmRunInput): Promise<KnowledgeSwarmOutcome> {
      const [claudePort, codexExecutor] = await Promise.all([
        deps.resolveClaudePort(input.repoRoot),
        deps.resolveCodexExecutor(input.repoRoot),
      ]);
      if (!claudePort && !codexExecutor) {
        return { status: "failed", reason: "no harness is available to run the knowledge swarm" };
      }
      const repoLabel = basename(input.repoRoot);
      return runKnowledgeSwarmForRepo({
        reader: new ProjectContextReader(deps.store),
        knowledgeStore: new KnowledgeStore(deps.store),
        claudePort,
        codexExecutor,
        repoKey: input.repoKey,
        repoRoot: input.repoRoot,
        baseOid: input.toOid,
        onProgress: (event) => deps.narrate(knowledgeStageLine(repoLabel, event)),
      });
    },
  };
}
