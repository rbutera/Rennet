import {
  boundedAll,
  buildPartitions,
  type CodexExecRequest,
  type CodexExecutor,
  dedupById,
  describeSnapshotGateFailure,
  dispositionCarrier,
  type HarnessPort,
  type HarnessSession,
  type HarnessTurnResult,
  KNOWLEDGE_SWARM_GENERATOR_ID,
  type KnowledgeSnapshotContext,
  knowledgeCoverageMatchesSnapshot,
  type LoadedSnapshot,
  MAP_SCOPE_GENERATOR_ID,
  MAP_SCOPE_OUTPUT_SCHEMA,
  MAP_SCOPE_SLICE_CAP,
  MAP_VERIFY_OUTPUT_SCHEMA,
  type MapScopeSuccess,
  type MapVerifyResult,
  mapScopeCatalogueDigest,
  materializeKnowledgeCoverage,
  PARTITION_WORKER_OUTPUT_SCHEMA,
  type PartitionSlice,
  type PartitionWorkerResult,
  partitionsFromSnapshot,
  planReverify,
  queryImportGraph,
  resolveAssignment,
  routeDelta,
  runMapScope,
  runMapVerify,
  runPartitionWorker,
  structuralChanges,
} from "@rennet/core";
import type {
  CouncilEffort,
  CouncilHarnessId,
  CouncilJobId,
  CouncilModel,
  CouncilResolveContext,
  KnowledgeCoverage,
  KnowledgeSet,
  KnowledgeStatement,
} from "@rennet/protocol";
import { canonicalize, KNOWLEDGE_SCHEMA_VERSION, sha256Hex } from "@rennet/protocol";
import { execaGit, type GitExec } from "./git-range-diff";
import {
  type JournalTarget,
  KnowledgeJournal,
  type ScopePlanJournalInput,
  type ScopePlanJournalResult,
} from "./knowledge-journal";
import type { KnowledgeStore } from "./knowledge-store";
import type { ProjectContextReader } from "./project-context-reader";
import { extractClaudeUsage, type MetricsCollector } from "./turn-metrics";

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

/**
 * The `from..to` changed-path closure via `git diff --name-only`. A git failure
 * THROWS: an unreadable diff must surface as a failed pass the caller retries,
 * never read as "no changed paths" (review P1 — a silent skip drops the missed
 * interval on the floor).
 */
export async function changedPathsBetween(
  git: GitExec,
  root: string,
  fromOid: string,
  toOid: string,
): Promise<string[]> {
  if (fromOid === toOid) return [];
  const out = await git(root, ["diff", "--name-only", "-z", `${fromOid}..${toOid}`], {
    reject: true,
  });
  return out.split("\0").filter((path) => path.length > 0);
}

/**
 * The exact bytes of the stored set, hashed — or `null` for no set at all.
 *
 * Content, not `baseOid`: two runs can promote at the same baseline (a re-extraction,
 * a generator bump) and produce different sets, and comparing baselines would call
 * that "unchanged". This is only ever compared for EQUALITY with an earlier read of
 * the same store, so a hash is all of it that needs keeping.
 */
function storeIdentity(set: KnowledgeSet | null): string | null {
  return set === null ? null : sha256Hex(canonicalize(set));
}

/** The full path inventory at `oid` (for PRIOR-snapshot partition ownership). */
async function pathsAtOid(git: GitExec, root: string, oid: string): Promise<string[]> {
  const out = await git(root, ["ls-tree", "-r", "--name-only", "-z", oid], { reject: true });
  return out.split("\0").filter((path) => path.length > 0);
}

function scopeSuccessFromPlan(plan: ScopePlanJournalResult): MapScopeSuccess {
  return {
    status: "ok",
    includedSliceIds: plan.includedSliceIds,
    excludedSlices: plan.excludedSlices,
    provenance: {
      generator: MAP_SCOPE_GENERATOR_ID,
      model: plan.provenance.model,
      apiKeySource: plan.provenance.apiKeySource,
    },
    attempts: 0,
  };
}

function coverageCounts(coverage: KnowledgeCoverage): {
  readonly scopeExcludedFiles: number;
  readonly mechanicallyExcludedFiles: number;
} {
  let scopeExcludedFiles = 0;
  let mechanicallyExcludedFiles = 0;
  for (const group of coverage.groups) {
    if (group.kind !== "excluded") continue;
    if (group.source === "scope") scopeExcludedFiles += group.files.length;
    else mechanicallyExcludedFiles += group.files.length;
  }
  return { scopeExcludedFiles, mechanicallyExcludedFiles };
}

function mappedOwners(coverage: KnowledgeCoverage): ReadonlyMap<string, string> {
  const owners = new Map<string, string>();
  for (const group of coverage.groups) {
    if (group.kind !== "mapped") continue;
    for (const file of group.files) owners.set(file.path, group.sliceId);
  }
  return owners;
}

/** Options shared by both concrete turn builders. */
export interface SwarmTurnOptions {
  /** The session's working directory (the repo root). Claude seats only. */
  readonly cwd: string;
  readonly signal?: AbortSignal;
  /** Optional cost-metrics tap (the same seam the cost harness reads). */
  readonly collector?: MetricsCollector;
  /** The metrics label, e.g. "knowledge.worker". */
  readonly label?: string;
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
  now: () => number = Date.now,
): RunTurn {
  const label = options.label ?? "knowledge.swarm";
  return async function runTurn(prompt: string, attempt: number): Promise<HarnessTurnResult> {
    const started = now();
    let observedModel: string | null = null;
    let apiKeySource: string | null = null;
    let session: HarnessSession | undefined;
    const record = (
      status: "emitted" | "failed",
      usage: ReturnType<typeof extractClaudeUsage>,
      error?: string,
    ): void => {
      options.collector?.record({
        label,
        docType: "review.hypothesis",
        attempt,
        model: observedModel,
        apiKeySource,
        status,
        latencyMs: now() - started,
        usage,
        ...(error === undefined ? {} : { error }),
      });
    };
    try {
      session = await port.createSession({
        cwd: options.cwd,
        outputSchema,
        model,
        // #585: Rennet's internal one-shot turn — never the user's session history.
        ephemeral: true,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      await session.send({ prompt });
      for await (const event of session.events) {
        if (event.kind === "session.started") {
          observedModel = event.model || null;
          apiKeySource = event.apiKeySource ?? null;
          continue;
        }
        if (event.kind === "error") {
          record("failed", null, event.error.message);
          return { status: "failed", message: event.error.message };
        }
        if (event.kind !== "session.ended") continue;
        const outcome = event.outcome;
        const usage = extractClaudeUsage(event.native);
        if (outcome.status === "completed") {
          if (outcome.structuredOutput === undefined) {
            const message = "the harness completed the swarm turn without structured output";
            record("failed", usage, message);
            return { status: "failed", message };
          }
          record("emitted", usage);
          return {
            status: "emitted",
            body: outcome.structuredOutput,
            observed: { model: observedModel ?? model, apiKeySource },
          };
        }
        const message =
          outcome.status === "failed" ? outcome.error.message : "the swarm turn was cancelled";
        record("failed", usage, message);
        return { status: "failed", message };
      }
      const message = "the harness stream ended without a terminal frame";
      record("failed", null, message);
      return { status: "failed", message };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record("failed", null, message);
      return { status: "failed", message };
    } finally {
      if (session !== undefined) {
        try {
          await session.close();
        } catch {
          // Closing a one-shot session is cleanup. It must not replace the emitted
          // result or the lifecycle failure already returned above.
        }
      }
    }
  };
}

/**
 * Build a swarm `runTurn` on the codex utility executor (the seat boundary the
 * council resolver names for a Codex pick — cheap Luna for the light worker
 * volume, per R39). The turn is ROOTED AT THE CHECKOUT (`cwd`): the swarm's
 * seats read real files as evidence, so the classic temp-dir utility posture
 * would leave a Codex seat reasoning from filenames alone (review P0). An
 * executor throw is an honest turn failure.
 */
export function createCodexSwarmTurn(
  executor: CodexExecutor,
  model: string,
  effort: string,
  outputSchema: unknown,
  options: Pick<SwarmTurnOptions, "signal" | "cwd"> & Pick<CodexExecRequest, "mcpServers">,
): RunTurn {
  return async function runTurn(prompt: string): Promise<HarnessTurnResult> {
    try {
      const result = await executor({
        model,
        effort,
        prompt,
        outputSchema,
        cwd: options.cwd,
        ...(options.mcpServers === undefined ? {} : { mcpServers: options.mcpServers }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      return {
        status: "emitted",
        body: result.output,
        observed: { model: result.model ?? model, apiKeySource: null },
      };
    } catch (error) {
      return { status: "failed", message: error instanceof Error ? error.message : String(error) };
    }
  };
}

/** One progress line from the swarm: per-partition states plus the verify stage. */
export type KnowledgeSwarmProgress =
  | {
      readonly kind: "scope";
      readonly status: "running" | "reused" | "done" | "failed";
      readonly candidates: number;
      readonly selected?: number;
      readonly scopeExcludedFiles?: number;
      readonly mechanicallyExcludedFiles: number;
      /** Selector model turns spent by this logical stage; zero for below-cap or reused plans. */
      readonly attempts?: number;
    }
  | {
      readonly kind: "partition";
      readonly sliceId: string;
      /** 1-based position among the slices this run executes. */
      readonly index: number;
      readonly total: number;
      /**
       * `reused` means the batch was NOT run: a journaled result from an earlier
       * attempt at this exact target answered it (#581). It is deliberately not
       * `done` — narrating a model turn that did not happen is a lie about spend.
       *
       * There is no `aborted` any more. A failed worker used to abandon every
       * worker still queued, because the pass was all-or-nothing and their work
       * would be thrown away regardless. With the journal it is not thrown away,
       * so the rest run, and a retry pays only for what actually failed.
       */
      readonly status: "queued" | "running" | "done" | "failed" | "reused";
      /** Minted statement count, present on `done` and `reused`. */
      readonly statements?: number;
    }
  | {
      readonly kind: "verify";
      readonly status: "running" | "done" | "failed";
      readonly confirmed?: number;
      readonly rejected?: number;
      readonly crossCutting?: number;
    };

/**
 * Concurrent partition workers, keyed by the harness that will own the process
 * family rather than by a global cap.
 *
 * The old default was a bare `?? 4`, which is where "200 partitions × 78 s ÷ 4 ≈ 67
 * minutes" came from. A Codex partition worker now starts without ambient MCP
 * processes, so its measured process family no longer has the same footprint as a
 * Claude worker. The clean Codex family still crossed the guarded 4 GiB ceiling at
 * 24 lanes, so Codex uses the ruled 16-lane cap while Claude stays at 12. Both remain
 * overridable per run (`KnowledgeSwarmDeps.concurrency`). The policy is deliberately
 * not adaptive: ambient load must not change the recorded run policy.
 */
export const DEFAULT_SWARM_CONCURRENCY_BY_HARNESS: Readonly<Record<CouncilHarnessId, number>> =
  Object.freeze({
    "claude-code": 12,
    codex: 16,
  });

/**
 * How many times a FAILED batch is retried before the run gives up on it. One: a
 * transient harness failure usually clears on a second attempt, and a batch that
 * fails twice is failing for a reason a third turn will not fix. (The worker itself
 * already retries once inside its own turn; this is a fresh attempt after every
 * other batch has run, which is a different kind of retry.)
 */
export const FAILED_BATCH_RETRIES = 1;

/** Everything one swarm run needs, injected by the composition root. */
export interface KnowledgeSwarmDeps {
  /** The fail-closed snapshot read gate (just the seam the swarm reads). */
  readonly reader: Pick<ProjectContextReader, "loadFresh">;
  /** The local knowledge store (just the seam the swarm touches). */
  readonly knowledgeStore: Pick<KnowledgeStore, "loadLocal" | "save" | "journalDir">;
  /** The Claude harness port, or null when no `claude` resolved. */
  readonly claudePort: HarnessPort | null;
  /** The codex utility executor, or null when no `codex` resolved. */
  readonly codexExecutor: CodexExecutor | null;
  readonly repoKey: string;
  readonly repoRoot: string;
  /** The resolved base OID the snapshot must be fresh at. */
  readonly baseOid: string;
  /** Council context override; default availability is computed from the two ports. */
  readonly council?: CouncilResolveContext;
  /**
   * Concurrent partition workers. Absent uses the selected worker harness's entry
   * in {@link DEFAULT_SWARM_CONCURRENCY_BY_HARNESS}.
   */
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
  readonly git?: GitExec;
  readonly onProgress?: (event: KnowledgeSwarmProgress) => void;
  /** Optional cost-metrics tap for Claude-seat turns (the cost harness's seam). */
  readonly collector?: MetricsCollector;
}

export type KnowledgeSwarmOutcome =
  | {
      readonly status: "ok";
      readonly set: KnowledgeSet;
      /** Selected slices this run executed (== selectedPartitions on a full run). */
      readonly ranPartitions: number;
      /** Candidate slices the persisted scope plan selected for model mapping. */
      readonly selectedPartitions: number;
      readonly totalPartitions: number;
      readonly scopeExcludedFiles: number;
      readonly mechanicallyExcludedFiles: number;
      readonly removedByCoverage: number;
      readonly reusedScopePlan: boolean;
      readonly failedPartitions: number;
      /** Batches answered from the journal instead of a model turn (#581). */
      readonly reusedPartitions: number;
      /**
       * Slices the partition-level rule would have re-run and the file-level rule did
       * not: every changed file they own was a body-only edit (W4). A number, so the
       * narration can say "N slices unchanged in structure, skipped" rather than
       * quietly running fewer turns than the changed set implies. Always 0 on a full
       * run — there is nothing to skip when nothing is carried.
       */
      readonly skippedCosmetic: number;
      /** Prior statements carried verbatim (incremental runs only). */
      readonly carried: number;
      readonly verify: MapVerifyResult;
    }
  | { readonly status: "skipped"; readonly reason: string }
  | {
      readonly status: "failed";
      readonly reason: string;
      /**
       * WHICH batches failed, when the failure was per-batch. Named because "3 of
       * 105 partition workers failed" tells an operator nothing about whether the
       * next run will get further, and because the journal means the surviving
       * batches' work is still on disk waiting for them.
       */
      readonly failedSlices?: readonly string[];
      /** Batches whose completed results are journaled and will be reused on a retry. */
      readonly journaled?: number;
    }
  | { readonly status: "snapshot-unavailable"; readonly reason: string };

/** The ports + options a council seat needs to become a concrete `runTurn`. */
export interface CouncilSeatDeps {
  readonly claudePort?: HarnessPort | null;
  readonly codexExecutor?: CodexExecutor | null;
  readonly repoRoot: string;
  readonly collector?: MetricsCollector;
  readonly signal?: AbortSignal;
  /** The metrics label for a Claude seat, e.g. "knowledge.worker". */
  readonly label?: string;
}

/**
 * Resolve one council job to a concrete `runTurn` on the resolved harness, or
 * an honest failure reason. Shared by the knowledge swarm and the project
 * scout (B7): the routing IS the council's, the ports are the caller's.
 */
export function councilSeatTurn(
  jobId: CouncilJobId,
  schema: unknown,
  deps: CouncilSeatDeps,
  council: CouncilResolveContext,
):
  | { runTurn: RunTurn; model: CouncilModel; harness: CouncilHarnessId; effort: CouncilEffort }
  | { failure: string } {
  const resolution = resolveAssignment(jobId, council);
  if (resolution.kind !== "model") {
    return { failure: `${jobId} resolved to no model (${resolution.trace.summary})` };
  }
  if (resolution.harness === "codex") {
    if (!deps.codexExecutor) return { failure: `${jobId} resolved to codex, which is unavailable` };
    return {
      harness: resolution.harness,
      model: resolution.model,
      effort: resolution.effort,
      // Rooted at the checkout: a Codex seat reads its evidence like a Claude
      // seat does — never reasons from filenames in a temp dir (review P0).
      runTurn: createCodexSwarmTurn(
        deps.codexExecutor,
        resolution.model,
        resolution.effort,
        schema,
        {
          cwd: deps.repoRoot,
          // Mapping fans out many light workers. Codex starts every configured MCP
          // server eagerly, even though these workers read the repository through
          // native tools. Keep the empty table job-scoped: every other Codex council
          // job inherits the executor's table as before.
          ...(jobId === "partition-worker" || jobId === "map-scope" || jobId === "map-verify"
            ? { mcpServers: {} }
            : {}),
          ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        },
      ),
    };
  }
  if (!deps.claudePort) {
    return { failure: `${jobId} resolved to claude-code, which is unavailable` };
  }
  return {
    harness: resolution.harness,
    model: resolution.model,
    effort: resolution.effort,
    runTurn: createClaudeSwarmTurn(deps.claudePort, resolution.model, schema, {
      cwd: deps.repoRoot,
      ...(deps.label === undefined ? {} : { label: deps.label }),
      ...(deps.collector === undefined ? {} : { collector: deps.collector }),
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    }),
  };
}

/** The swarm's seat resolution: `councilSeatTurn` with the swarm's labels. */
function turnFor(
  jobId: "map-scope" | "partition-worker" | "map-verify",
  schema: unknown,
  deps: KnowledgeSwarmDeps,
  council: CouncilResolveContext,
):
  | { runTurn: RunTurn; model: CouncilModel; harness: CouncilHarnessId; effort: CouncilEffort }
  | { failure: string } {
  return councilSeatTurn(
    jobId,
    schema,
    {
      claudePort: deps.claudePort,
      codexExecutor: deps.codexExecutor,
      repoRoot: deps.repoRoot,
      label:
        jobId === "map-scope"
          ? "knowledge.scope"
          : jobId === "map-verify"
            ? "knowledge.verify"
            : "knowledge.worker",
      ...(deps.collector === undefined ? {} : { collector: deps.collector }),
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    },
    council,
  );
}

/**
 * Run the council-routed knowledge swarm for a repo and persist the set.
 * Gates the snapshot fresh (typed `snapshot-unavailable`, never a fabricated
 * set), partitions it, fans out the workers on the resolved harness, runs the
 * verify/synthesis seat, and — on `ok` — writes the store. A failed run leaves
 * the store untouched (knowledge degrades to absent honestly).
 *
 * The runner decides its own mode from the PRIOR SET'S IDENTITY (review P1 —
 * never a caller-supplied `fromOid`): a prior set from this generator+schema at
 * this baseline is a no-op skip; at an older baseline it is an incremental run
 * (delta base = `prior.baseOid`, only owning partitions re-run, untouched
 * statements carry verbatim, dispositions durable by id); a prior set from a
 * FOREIGN generator or schema (the retired flat pass) is replaced by a full
 * run — it never survives as carry substrate.
 */
export async function runKnowledgeSwarmForRepo(
  deps: KnowledgeSwarmDeps,
): Promise<KnowledgeSwarmOutcome> {
  const gated = deps.reader.loadFresh(deps.repoKey, deps.baseOid);
  if (!gated.ok) {
    return { status: "snapshot-unavailable", reason: describeSnapshotGateFailure(gated.failure) };
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

  // Module batches over the import graph, with the directory tier as the honest
  // fallback for edge-less files and for a snapshot whose shards cannot be read.
  const partitions = partitionsFromSnapshot(gated.snapshot);
  const catalogueDigest = mapScopeCatalogueDigest(gated.snapshot, partitions);
  const loaded = deps.knowledgeStore.loadLocal(deps.repoKey);
  // What the store held when this run decided what to do. Re-read at save time: a
  // run's whole plan — full or incremental, which slices, what carries — is derived
  // from this, so a store that moved underneath it makes every one of those
  // decisions stale. See the refusal at the save below.
  const priorIdentity = storeIdentity(loaded);
  const priorShapeEligible =
    loaded !== null &&
    loaded.generator === KNOWLEDGE_SWARM_GENERATOR_ID &&
    loaded.schemaVersion === KNOWLEDGE_SCHEMA_VERSION &&
    loaded.coverage !== undefined;
  let priorCoverageSnapshot: LoadedSnapshot | null = null;
  if (priorShapeEligible) {
    const candidate =
      loaded.baseOid === snapshot.baseOid &&
      loaded.snapshotFingerprint === snapshot.snapshotFingerprint
        ? gated
        : deps.reader.loadFresh(deps.repoKey, loaded.baseOid);
    if (candidate.ok && candidate.snapshot.manifest.fingerprint === loaded.snapshotFingerprint) {
      if (knowledgeCoverageMatchesSnapshot(loaded.coverage, candidate.snapshot)) {
        priorCoverageSnapshot = candidate.snapshot;
      }
    }
  }
  const priorEligible = priorShapeEligible && priorCoverageSnapshot !== null;
  const prior = priorEligible ? loaded : null;
  if (
    prior &&
    prior.baseOid === snapshot.baseOid &&
    prior.snapshotFingerprint === snapshot.snapshotFingerprint
  ) {
    return { status: "skipped", reason: "the knowledge set is already current at this baseline" };
  }
  // A re-extraction can replace the materialized snapshot at the SAME commit. Git
  // has no interval to route in that case, so the only honest answer is a full
  // selected refresh; treating the matching OID as an incremental base would turn
  // `changedPathsBetween` into [] and preserve answers to the old extraction.
  const priorForDelta = prior?.baseOid === snapshot.baseOid ? null : prior;

  const journal = new KnowledgeJournal(deps.knowledgeStore.journalDir(deps.repoKey));
  const target: JournalTarget = {
    baseOid: snapshot.baseOid,
    snapshotFingerprint: snapshot.snapshotFingerprint,
    generator: KNOWLEDGE_SWARM_GENERATOR_ID,
  };
  const mechanicallyExcludedFiles = Math.max(
    0,
    snapshot.files.length - partitions.reduce((count, slice) => count + slice.files.length, 0),
  );

  let scopeSelection: MapScopeSuccess;
  let scopeSelector: Parameters<typeof materializeKnowledgeCoverage>[0]["selector"];
  let reusedScopePlan = false;
  let scopePlanToWrite: {
    readonly input: ScopePlanJournalInput;
    readonly result: ScopePlanJournalResult;
  } | null = null;
  if (partitions.length <= MAP_SCOPE_SLICE_CAP) {
    deps.onProgress?.({
      kind: "scope",
      status: "running",
      candidates: partitions.length,
      mechanicallyExcludedFiles,
    });
    const result = await runMapScope({
      snapshot: gated.snapshot,
      candidates: partitions,
      provenance: { model: null, apiKeySource: null },
      runTurn: async () => ({
        status: "failed",
        message: "the below-cap selector unexpectedly requested a model turn",
      }),
    });
    if (result.status === "failed") {
      deps.onProgress?.({
        kind: "scope",
        status: "failed",
        candidates: partitions.length,
        mechanicallyExcludedFiles,
        attempts: result.attempts,
      });
      return { status: "failed", reason: result.failureReason };
    }
    scopeSelection = result;
    scopeSelector = { kind: "below-cap" };
  } else {
    const scope = turnFor("map-scope", MAP_SCOPE_OUTPUT_SCHEMA, deps, council);
    if ("failure" in scope) return { status: "failed", reason: scope.failure };
    const journalInput: ScopePlanJournalInput = {
      selectorGenerator: MAP_SCOPE_GENERATOR_ID,
      catalogueDigest,
      sliceCap: MAP_SCOPE_SLICE_CAP,
      candidateSliceIds: partitions.map((slice) => slice.id),
      assignment: { harness: scope.harness, model: scope.model, effort: scope.effort },
    };
    const reusable = journal.readScopePlan(target, journalInput);
    if (reusable !== null) {
      scopeSelection = scopeSuccessFromPlan(reusable);
      reusedScopePlan = true;
    } else {
      deps.onProgress?.({
        kind: "scope",
        status: "running",
        candidates: partitions.length,
        mechanicallyExcludedFiles,
      });
      const result = await runMapScope({
        snapshot: gated.snapshot,
        candidates: partitions,
        provenance: { model: scope.model, apiKeySource: null },
        runTurn: scope.runTurn,
      });
      if (result.status === "failed") {
        deps.onProgress?.({
          kind: "scope",
          status: "failed",
          candidates: partitions.length,
          mechanicallyExcludedFiles,
          attempts: result.attempts,
        });
        return { status: "failed", reason: `context-map coverage failed: ${result.failureReason}` };
      }
      scopeSelection = result;
    }
    const observedModel = scopeSelection.provenance.model;
    if (observedModel === null) {
      return { status: "failed", reason: "context-map coverage did not report its model" };
    }
    scopeSelector = {
      kind: "council",
      harness: scope.harness,
      assignedModel: scope.model,
      model: observedModel,
      effort: scope.effort,
      apiKeySource: scopeSelection.provenance.apiKeySource,
    };
    if (!reusedScopePlan) {
      scopePlanToWrite = {
        input: journalInput,
        result: {
          includedSliceIds: scopeSelection.includedSliceIds,
          excludedSlices: scopeSelection.excludedSlices,
          provenance: scopeSelection.provenance,
        },
      };
    }
  }

  let coverage: KnowledgeCoverage;
  try {
    coverage = materializeKnowledgeCoverage({
      snapshot: gated.snapshot,
      candidates: partitions,
      selection: scopeSelection,
      selector: scopeSelector,
    });
  } catch (error) {
    deps.onProgress?.({
      kind: "scope",
      status: "failed",
      candidates: partitions.length,
      mechanicallyExcludedFiles,
      attempts: scopeSelection.attempts,
    });
    const message = error instanceof Error ? error.message : String(error);
    return { status: "failed", reason: `context-map coverage materialization failed: ${message}` };
  }
  if (scopePlanToWrite !== null) {
    journal.writeScopePlan(target, scopePlanToWrite.input, scopePlanToWrite.result);
  }
  const coverageSummary = coverageCounts(coverage);
  deps.onProgress?.({
    kind: "scope",
    status: reusedScopePlan ? "reused" : "done",
    candidates: partitions.length,
    selected: scopeSelection.includedSliceIds.length,
    scopeExcludedFiles: coverageSummary.scopeExcludedFiles,
    mechanicallyExcludedFiles: coverageSummary.mechanicallyExcludedFiles,
    attempts: scopeSelection.attempts,
  });
  const selectedIds = new Set(scopeSelection.includedSliceIds);
  const selectedPartitions = partitions.filter((slice) => selectedIds.has(slice.id));

  let slicesToRun: readonly PartitionSlice[] = selectedPartitions;
  let carried: readonly KnowledgeStatement[] = [];
  let reverify: readonly KnowledgeStatement[] = [];
  let skippedCosmetic = 0;
  let removedByCoverage = 0;
  const currentOwners = mappedOwners(coverage);
  if (priorForDelta) {
    const git = deps.git ?? execaGit;
    let changed: string[];
    let priorPaths: string[];
    try {
      changed = await changedPathsBetween(
        git,
        deps.repoRoot,
        priorForDelta.baseOid,
        snapshot.baseOid,
      );
      priorPaths = await pathsAtOid(git, deps.repoRoot, priorForDelta.baseOid);
    } catch (error) {
      // An unreadable interval is a FAILED pass the scheduler retries — reading
      // it as "nothing changed" would silently drop the whole delta (review P1).
      const message = error instanceof Error ? error.message : String(error);
      return { status: "failed", reason: `changed-path resolution failed: ${message}` };
    }
    // Prior ownership for orphaned (deleted / re-scoped) paths: the prior
    // inventory partitioned under the current scope graph (blobOids are not
    // consulted by routing).
    const priorPartitions = buildPartitions({
      ...snapshot,
      files: priorPaths.map((path) => ({ path, blobOid: "" })),
    });
    // THE SIGNATURE DIFF (W4). Routing is given the STRUCTURAL subset of the changed
    // set, so a body-only edit costs no worker turn. The prior snapshot is loaded
    // through the same fail-closed gate; when it will not materialize — never built,
    // evicted, corrupt — there is nothing to compare against and `structuralChanges`
    // is handed `null`, which returns the changed set whole. Fewer turns is a saving
    // only when it is provably the same map; unprovable means run it.
    const priorSnapshot = priorCoverageSnapshot;
    // ⚠️ The OID is NOT enough to identify the prior snapshot. A manifest is stored
    // per baseline and OVERWRITTEN in place, so a re-extraction at that same OID — a
    // new symbol or import extractor, a changed inventory — replaces the view the
    // stored statements were learned against while the OID stays put. Comparing the
    // current snapshot against THAT one answers "did the file's signature move" from
    // two different extractions, which can read identical when the code moved and
    // different when it did not. `snapshotFingerprint` is the extraction's identity
    // and the knowledge set records the one it learned against, so it is the join.
    //
    // A mismatch means we hold no comparable prior, which is exactly the case
    // `structuralChanges(…, null)` exists for: the whole change is structural and
    // every touched slice re-runs. Fail-safe, and the same direction every other
    // unanswerable case in this pass takes.
    const priorComparable =
      priorSnapshot?.manifest.fingerprint === priorForDelta.snapshotFingerprint
        ? priorSnapshot
        : null;
    const structural = structuralChanges(changed, gated.snapshot, priorComparable);
    const structurallyRouted = new Set(
      routeDelta(partitions, structural, priorPartitions)
        .filter((slice) => selectedIds.has(slice.id))
        .map((slice) => slice.id),
    );
    const priorOwners = mappedOwners(priorForDelta.coverage as KnowledgeCoverage);
    const forcedByCoverage = new Set<string>();
    for (const [path, sliceId] of currentOwners) {
      if (priorOwners.get(path) !== sliceId) forcedByCoverage.add(sliceId);
    }
    slicesToRun = partitions.filter(
      (slice) =>
        selectedIds.has(slice.id) &&
        (structurallyRouted.has(slice.id) || forcedByCoverage.has(slice.id)),
    );
    // What the partition-level rule would have run, minus what the file-level rule
    // does — computed, not inferred, because "3 slices ran" and "3 slices ran and 9
    // were structurally unchanged" are different reports of the same run.
    skippedCosmetic =
      structural.length === changed.length
        ? 0
        : routeDelta(partitions, changed, priorPartitions).filter((slice) =>
            selectedIds.has(slice.id),
          ).length - structurallyRouted.size;
    // `changed`, NOT `structural`: re-anchoring is driven by blobOids moving, and a
    // cosmetic edit moves them. A statement citing a body-only edit still gets its
    // anchors re-stamped and still reaches the verify seat flagged; what it does not
    // do is re-run its slice's worker. Narrowing this to `structural` would leave
    // statements anchored to bytes that no longer exist.
    const currentInventory = new Set(snapshot.files.map((file) => file.path));
    const coverageEligibleStatements = priorForDelta.statements.filter((statement) =>
      statement.evidence.every(
        (anchor) => !currentInventory.has(anchor.path) || currentOwners.has(anchor.path),
      ),
    );
    removedByCoverage = priorForDelta.statements.length - coverageEligibleStatements.length;
    const plan = planReverify(
      { ...priorForDelta, statements: coverageEligibleStatements },
      changed,
      snapshot.files,
    );
    carried = plan.carried;
    // `plan.invalidated` (evidence entirely gone) is deliberately NOT carried and
    // NOT re-verified: those statements die with their evidence. The rest reach the
    // verify seat as FLAGGED entries — the merge pass cannot settle a statement
    // whose cited bytes moved, so it is judgment by construction.
    reverify = plan.reverify;
  }

  // Seat-level seeds: each mint names the model the council resolved for THAT
  // seat; a turn's observed facts override at mint time (review P2).
  const provenance = { model: worker.model, apiKeySource: null };
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
  let reusedPartitions = 0;

  /** Run one batch, or answer it from the journal. Journals a fresh success. */
  const runBatch = async (
    slice: PartitionSlice,
    index: number,
    allowReuse: boolean,
  ): Promise<PartitionWorkerResult> => {
    const progress = { kind: "partition", sliceId: slice.id, index: index + 1, total } as const;
    const journaled = allowReuse ? journal.read(target, slice) : null;
    if (journaled !== null) {
      reusedPartitions += 1;
      deps.onProgress?.({ ...progress, status: "reused", statements: journaled.statements.length });
      return journaled;
    }
    deps.onProgress?.({ ...progress, status: "running" });
    const result = await runPartitionWorker({
      slice,
      snapshot,
      provenance,
      runTurn: worker.runTurn,
    });
    journal.write(target, slice, result);
    deps.onProgress?.({
      ...progress,
      status: result.status === "ok" ? "done" : "failed",
      ...(result.status === "ok" ? { statements: result.statements.length } : {}),
    });
    return result;
  };

  // Every batch runs. It used to be first-failure-aborts-the-rest, because the pass
  // was all-or-keep-prior and their work was going to be thrown away anyway; with
  // the journal it is kept, so finishing the run makes the retry cheap instead of
  // making this one expensive.
  const concurrency = deps.concurrency ?? DEFAULT_SWARM_CONCURRENCY_BY_HARNESS[worker.harness];
  let outcomes = await boundedAll(
    slicesToRun.map((slice, index) => () => runBatch(slice, index, true)),
    concurrency,
  );

  // One fresh attempt at whatever failed, after the rest have finished. A batch that
  // fails twice is failing for a reason a third turn will not fix.
  for (let attempt = 0; attempt < FAILED_BATCH_RETRIES; attempt += 1) {
    const failedIndexes = outcomes.flatMap((result, index) =>
      result.status === "failed" ? [index] : [],
    );
    if (failedIndexes.length === 0) break;
    const retried = await boundedAll(
      failedIndexes.map((index) => () => {
        const slice = slicesToRun[index];
        // `allowReuse: false` — a journal read here would answer with the failure's
        // own absence, not with work; the point is a genuinely new turn.
        return slice === undefined
          ? Promise.resolve(outcomes[index] as PartitionWorkerResult)
          : runBatch(slice, index, false);
      }),
      concurrency,
    );
    const next = [...outcomes];
    for (const [position, index] of failedIndexes.entries()) {
      const result = retried[position];
      if (result !== undefined) next[index] = result;
    }
    outcomes = next;
  }

  const results: PartitionWorkerResult[] = [];
  const failedSlices: string[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === "failed") failedSlices.push(outcome.sliceId);
    else results.push(outcome);
  }
  // ALL-OR-KEEP-PRIOR still holds (review P1): a partial swarm must never REPLACE
  // the store — a set silently missing failed slices' knowledge reads as complete.
  // What changed is what happens to the work: the prior set stays, and every batch
  // that DID complete is journaled, so the scheduler's retry re-runs only the
  // failures. The journal is deliberately NOT cleared here.
  if (failedSlices.length > 0) {
    return {
      status: "failed",
      reason: `${failedSlices.length} of ${total} partition workers failed after a retry; ${results.length} completed batches are journaled for the next run`,
      failedSlices,
      // THIS run's completed batches, which is what the reason line says. The
      // journal's own entry count would disagree with it the moment a retry ran a
      // subset of the slices, and it counted every target's entries besides.
      journaled: results.length,
    };
  }

  deps.onProgress?.({ kind: "verify", status: "running" });
  const importGraph = queryImportGraph(gated.snapshot);
  const verifyResult = await runMapVerify({
    workerResults: results,
    slices: slicesToRun,
    snapshot,
    // The AUTHORITATIVE edges the merge checks import-shaped claims against. Absent
    // when the graph could not be read, which the merge treats as "contradicts
    // nothing" rather than as "contradicts everything".
    ...(importGraph.ok
      ? {
          importEdges: importGraph.graph.edges.map((edge) => ({ from: edge.from, to: edge.to })),
        }
      : {}),
    ...(reverify.length === 0 ? {} : { reverify }),
    provenance: { model: verify.model, apiKeySource: null },
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
  const carrier = priorForDelta ? dispositionCarrier(priorForDelta) : null;
  const candidates = dedupById([...verifyResult.set.statements, ...carried]);
  const statements = candidates.filter((statement) =>
    statement.evidence.every((anchor) => currentOwners.has(anchor.path)),
  );
  removedByCoverage += candidates.length - statements.length;
  const set: KnowledgeSet = {
    ...verifyResult.set,
    coverage,
    statements: carrier === null ? statements : statements.map(carrier),
  };
  // SUPERSEDED CHECK. Everything above was decided from the prior set read at the
  // top of this run — full or incremental, which slices, which statements carry.
  // Between that read and here sit every worker turn and the verify seat, minutes
  // of it, and if another run promoted in that window then this set was computed
  // against a prior that no longer exists and writing it would silently roll the
  // store back to an older target.
  //
  // WHERE THE RACE COMES FROM, since the obvious answer is wrong: proactive
  // rehydration IS single-flight per repo (`knowledgeRunning` in
  // `proactive-rehydration.ts`), so its own baseline advances queue behind each
  // other. The second runner is the REVIEW-OPEN kick in `live-review-backend.ts`,
  // which fires whenever a review opens with no local set and knows nothing about
  // the watcher's flight. Nothing coordinates the two.
  //
  // Refuse, do not merge: this run's inputs are stale, and the journal is what makes
  // that cheap — it is deliberately NOT cleared, so the retry re-runs no turns and
  // merges against the prior that actually exists.
  //
  // ponytail: this NARROWS the race from minutes to microseconds, it does not close
  // it. The read below and the `save` after it are not one atomic operation, so two
  // runs finishing inside that read-compare-write window both see an unmoved store
  // and the last writer wins. Closing it needs the store to do a compare-and-swap on
  // the prior's identity; that is a store-layer change, and the window it would buy
  // back is the distance between two adjacent statements. The minutes-wide window
  // this check does close is the one that was actually losing work.
  if (storeIdentity(deps.knowledgeStore.loadLocal(deps.repoKey)) !== priorIdentity) {
    return {
      status: "failed",
      reason:
        "superseded: another run wrote the knowledge store while this one was running, so this set was computed against a prior that no longer exists; every completed batch stays journaled for the retry",
      journaled: results.length,
    };
  }
  // THE one store write, and it happens exactly here: after every batch, the merge
  // and the verify seat have all completed. The set is whole or it is not written.
  deps.knowledgeStore.save(deps.repoKey, set);
  // Promoted, so THIS target's journal has nothing left to protect. Another target's
  // journal is another run's recovery and is never this run's to delete.
  journal.clear(target);
  return {
    status: "ok",
    set,
    ranPartitions: slicesToRun.length,
    selectedPartitions: selectedPartitions.length,
    totalPartitions: partitions.length,
    scopeExcludedFiles: coverageSummary.scopeExcludedFiles,
    mechanicallyExcludedFiles: coverageSummary.mechanicallyExcludedFiles,
    removedByCoverage,
    reusedScopePlan,
    failedPartitions: 0,
    reusedPartitions,
    skippedCosmetic,
    carried: carried.length,
    verify: verifyResult,
  };
}
