import {
  buildPartitions,
  type CodexExecutor,
  dedupById,
  dispositionCarrier,
  type HarnessPort,
  type HarnessTurnResult,
  type KnowledgeSnapshotContext,
  type LoadedSnapshot,
  MAP_VERIFY_OUTPUT_SCHEMA,
  type MapVerifyResult,
  PARTITION_WORKER_OUTPUT_SCHEMA,
  type PartitionSlice,
  type PartitionWorkerResult,
  planReverify,
  resolveAssignment,
  routeDelta,
  runMapVerify,
  runPartitionWorker,
} from "@rennet/core";
import type {
  CouncilHarnessId,
  CouncilResolveContext,
  KnowledgeSet,
  KnowledgeStatement,
} from "@rennet/protocol";
import { execaGit, type GitExec } from "./git-range-diff";
import type { KnowledgeStore } from "./knowledge-store";
import type { ProjectContextReader } from "./project-context-reader";

/**
 * The ADAPTER side of the partitioned knowledge swarm (#460, B06 cluster 5):
 * council-routed execution over the pure `core/knowledge/` plumbing. This module
 * resolves `partition-worker` and `map-verify` through `resolveAssignment`
 * (availability computed from the ports the composition root actually resolved),
 * builds the concrete `runTurn` on the RESOLVED harness — the user's own `claude`
 * for a Claude seat, the codex utility executor for a Codex seat — fans the
 * workers out with bounded concurrency, feeds the verify/synthesis seat, and
 * writes the store.
 *
 * NO `InvocationBudget` anywhere on this path: the map path is uncapped by
 * decision (#460 point 5, proposal reconciliation 4). R10 stays intact on every
 * other model path.
 */

type RunTurn = (prompt: string, attempt: number) => Promise<HarnessTurnResult>;

/** Project a materialized snapshot into the compact context the swarm reasons over. */
export function snapshotContextFromLoaded(loaded: LoadedSnapshot): KnowledgeSnapshotContext {
  return {
    repoKey: loaded.manifest.repoKey,
    baseOid: loaded.manifest.baseOid,
    snapshotFingerprint: loaded.manifest.fingerprint,
    files: loaded.files.map((file) => ({ path: file.path, blobOid: file.blobOid })),
    scopes: loaded.scopes.map((scope) => ({ name: scope.name, root: scope.root })),
  };
}

/** The `from..to` changed-path closure via `git diff --name-only` (empty on any git error). */
export async function changedPathsBetween(
  git: GitExec,
  root: string,
  fromOid: string,
  toOid: string,
): Promise<string[]> {
  if (fromOid === toOid) return [];
  try {
    const out = await git(root, ["diff", "--name-only", "-z", `${fromOid}..${toOid}`], {
      reject: true,
    });
    return out.split("\0").filter((path) => path.length > 0);
  } catch {
    return [];
  }
}

/** Options shared by both concrete turn builders. */
export interface SwarmTurnOptions {
  /** The read-only session's working directory (the repo root). Claude seats only. */
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

/**
 * Build a swarm `runTurn` on a Claude harness port, constrained to the given
 * output schema (mirrors the retired flat pass's turn builder, schema-injected
 * because the swarm runs two different seats through it).
 */
export function createClaudeSwarmTurn(
  port: HarnessPort,
  model: string,
  outputSchema: unknown,
  options: SwarmTurnOptions,
): RunTurn {
  return async function runTurn(prompt: string): Promise<HarnessTurnResult> {
    const session = await port.createSession({
      cwd: options.cwd,
      outputSchema,
      model,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    try {
      await session.send({ prompt });
      for await (const event of session.events) {
        if (event.kind === "error") return { status: "failed", message: event.error.message };
        if (event.kind !== "session.ended") continue;
        const outcome = event.outcome;
        if (outcome.status === "completed") {
          if (outcome.structuredOutput === undefined) {
            return {
              status: "failed",
              message: "the harness completed the swarm turn without structured output",
            };
          }
          return { status: "emitted", body: outcome.structuredOutput };
        }
        return {
          status: "failed",
          message:
            outcome.status === "failed" ? outcome.error.message : "the swarm turn was cancelled",
        };
      }
      return { status: "failed", message: "the harness stream ended without a terminal frame" };
    } finally {
      await session.close();
    }
  };
}

/**
 * Build a swarm `runTurn` on the codex utility executor (the seat boundary the
 * council resolver names for a Codex pick — cheap Luna for the light worker
 * volume, per R39). An executor throw is an honest turn failure.
 */
export function createCodexSwarmTurn(
  executor: CodexExecutor,
  model: string,
  effort: string,
  outputSchema: unknown,
  options: Pick<SwarmTurnOptions, "signal"> = {},
): RunTurn {
  return async function runTurn(prompt: string): Promise<HarnessTurnResult> {
    try {
      const result = await executor({
        model,
        effort,
        prompt,
        outputSchema,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      return { status: "emitted", body: result.output };
    } catch (error) {
      return { status: "failed", message: error instanceof Error ? error.message : String(error) };
    }
  };
}

/** One progress line from the swarm: per-partition states plus the verify stage. */
export type KnowledgeSwarmProgress =
  | {
      readonly kind: "partition";
      readonly sliceId: string;
      /** 1-based position among the slices this run executes. */
      readonly index: number;
      readonly total: number;
      readonly status: "queued" | "running" | "done" | "failed";
      /** Minted statement count, present on `done`. */
      readonly statements?: number;
    }
  | {
      readonly kind: "verify";
      readonly status: "running" | "done" | "failed";
      readonly confirmed?: number;
      readonly rejected?: number;
      readonly crossCutting?: number;
    };

/** Everything one swarm run needs, injected by the composition root. */
export interface KnowledgeSwarmDeps {
  readonly reader: ProjectContextReader;
  readonly knowledgeStore: KnowledgeStore;
  /** The Claude harness port, or null when no `claude` resolved. */
  readonly claudePort: HarnessPort | null;
  /** The codex utility executor, or null when no `codex` resolved. */
  readonly codexExecutor: CodexExecutor | null;
  readonly repoKey: string;
  readonly repoRoot: string;
  /** The resolved base OID the snapshot must be fresh at. */
  readonly baseOid: string;
  /**
   * The OID the prior knowledge set was generated against. When given and a
   * prior set exists, the run is INCREMENTAL: only partitions owning changed
   * paths re-run, and untouched statements carry verbatim.
   */
  readonly fromOid?: string;
  /** Council context override; default availability is computed from the two ports. */
  readonly council?: CouncilResolveContext;
  /** Concurrent partition workers. Default 4. */
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
  readonly git?: GitExec;
  readonly onProgress?: (event: KnowledgeSwarmProgress) => void;
}

export type KnowledgeSwarmOutcome =
  | {
      readonly status: "ok";
      readonly set: KnowledgeSet;
      /** Slices this run executed (== total on a full run). */
      readonly ranPartitions: number;
      readonly totalPartitions: number;
      readonly failedPartitions: number;
      /** Prior statements carried verbatim (incremental runs only). */
      readonly carried: number;
      readonly verify: MapVerifyResult;
    }
  | { readonly status: "skipped"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "snapshot-unavailable"; readonly reason: string };

/** Resolve one swarm job to a concrete `runTurn`, or an honest failure reason. */
function turnFor(
  jobId: "partition-worker" | "map-verify",
  schema: unknown,
  deps: KnowledgeSwarmDeps,
  council: CouncilResolveContext,
): { runTurn: RunTurn } | { failure: string } {
  const resolution = resolveAssignment(jobId, council);
  if (resolution.kind !== "model") {
    return { failure: `${jobId} resolved to no model (${resolution.trace.summary})` };
  }
  if (resolution.harness === "codex") {
    if (!deps.codexExecutor) return { failure: `${jobId} resolved to codex, which is unavailable` };
    return {
      runTurn: createCodexSwarmTurn(
        deps.codexExecutor,
        resolution.model,
        resolution.effort,
        schema,
        {
          ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        },
      ),
    };
  }
  if (!deps.claudePort) {
    return { failure: `${jobId} resolved to claude-code, which is unavailable` };
  }
  return {
    runTurn: createClaudeSwarmTurn(deps.claudePort, resolution.model, schema, {
      cwd: deps.repoRoot,
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    }),
  };
}

/** Run `tasks` with at most `limit` in flight (order of completion is irrelevant). */
async function boundedAll<T>(tasks: readonly (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, async () => {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      const task = tasks[index];
      if (task) results[index] = await task();
    }
  });
  await Promise.all(lanes);
  return results;
}

/**
 * Run the council-routed knowledge swarm for a repo and persist the set.
 * Gates the snapshot fresh (typed `snapshot-unavailable`, never a fabricated
 * set), partitions it, fans out the workers on the resolved harness, runs the
 * verify/synthesis seat, and — on `ok` — writes the store. A failed run leaves
 * the store untouched (knowledge degrades to absent honestly). Incremental when
 * `fromOid` is given and a prior set exists: only owning partitions re-run,
 * untouched statements carry verbatim, prior dispositions stay durable by id.
 */
export async function runKnowledgeSwarmForRepo(
  deps: KnowledgeSwarmDeps,
): Promise<KnowledgeSwarmOutcome> {
  const gated = deps.reader.loadFresh(deps.repoKey, deps.baseOid);
  if (!gated.ok) {
    return { status: "snapshot-unavailable", reason: gated.failure.reason };
  }
  const snapshot = snapshotContextFromLoaded(gated.snapshot);

  const installed: CouncilHarnessId[] = [];
  if (deps.claudePort) installed.push("claude-code");
  if (deps.codexExecutor) installed.push("codex");
  const council = deps.council ?? { availability: { installed } };

  const worker = turnFor("partition-worker", PARTITION_WORKER_OUTPUT_SCHEMA, deps, council);
  if ("failure" in worker) return { status: "failed", reason: worker.failure };
  const verify = turnFor("map-verify", MAP_VERIFY_OUTPUT_SCHEMA, deps, council);
  if ("failure" in verify) return { status: "failed", reason: verify.failure };

  const partitions = buildPartitions(snapshot);
  const prior = deps.knowledgeStore.loadLocal(deps.repoKey);

  let slicesToRun: readonly PartitionSlice[] = partitions;
  let carried: readonly KnowledgeStatement[] = [];
  let priorReverify: PartitionWorkerResult | null = null;
  if (prior && deps.fromOid !== undefined) {
    const changed = await changedPathsBetween(
      deps.git ?? execaGit,
      deps.repoRoot,
      deps.fromOid,
      deps.baseOid,
    );
    if (changed.length === 0) {
      return { status: "skipped", reason: "no changed paths between the baselines" };
    }
    slicesToRun = routeDelta(partitions, changed);
    const plan = planReverify(prior, changed);
    carried = plan.carried;
    if (plan.reverify.length > 0) {
      // Prior statements whose cited evidence changed re-enter the verify seat as
      // a synthetic worker result (no hints; the seat re-adjudicates per span).
      priorReverify = {
        sliceId: "prior:reverify",
        status: "ok",
        statements: plan.reverify.map((statement) => ({ statement })),
        droppedAnchors: 0,
        droppedStatements: 0,
        attempts: 0,
      };
    }
  }

  const provenance = { model: null, apiKeySource: null };
  const total = slicesToRun.length;
  for (const [index, slice] of slicesToRun.entries()) {
    deps.onProgress?.({
      kind: "partition",
      sliceId: slice.id,
      index: index + 1,
      total,
      status: "queued",
    });
  }
  const results = await boundedAll(
    slicesToRun.map((slice, index) => async () => {
      deps.onProgress?.({
        kind: "partition",
        sliceId: slice.id,
        index: index + 1,
        total,
        status: "running",
      });
      const result = await runPartitionWorker({
        slice,
        snapshot,
        provenance,
        runTurn: worker.runTurn,
      });
      deps.onProgress?.({
        kind: "partition",
        sliceId: slice.id,
        index: index + 1,
        total,
        status: result.status === "ok" ? "done" : "failed",
        ...(result.status === "ok" ? { statements: result.statements.length } : {}),
      });
      return result;
    }),
    deps.concurrency ?? 4,
  );
  const failedPartitions = results.filter((result) => result.status === "failed").length;
  if (failedPartitions === results.length && results.length > 0 && priorReverify === null) {
    return { status: "failed", reason: "every partition worker failed" };
  }

  deps.onProgress?.({ kind: "verify", status: "running" });
  const verifyResult = await runMapVerify({
    workerResults: priorReverify === null ? results : [...results, priorReverify],
    snapshot,
    provenance,
    runTurn: verify.runTurn,
  });
  if (verifyResult.status !== "ok" || verifyResult.set === undefined) {
    deps.onProgress?.({ kind: "verify", status: "failed" });
    return {
      status: "failed",
      reason: verifyResult.failureReason ?? "the verify/synthesis seat did not complete",
    };
  }
  deps.onProgress?.({
    kind: "verify",
    status: "done",
    confirmed: verifyResult.confirmed,
    rejected: verifyResult.rejected,
    crossCutting: verifyResult.crossCutting,
  });

  // Fresh verdicts win an id collision (dedup keeps first); carried statements
  // follow; prior human/seat dispositions stay durable by id (shipped rule).
  const carrier = prior ? dispositionCarrier(prior) : null;
  const statements = dedupById([...verifyResult.set.statements, ...carried]);
  const set: KnowledgeSet = {
    ...verifyResult.set,
    statements: carrier === null ? statements : statements.map(carrier),
  };
  deps.knowledgeStore.save(deps.repoKey, set);
  return {
    status: "ok",
    set,
    ranPartitions: slicesToRun.length,
    totalPartitions: partitions.length,
    failedPartitions,
    carried: carried.length,
    verify: verifyResult,
  };
}
