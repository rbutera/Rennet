import {
  type HarnessPort,
  type HarnessTurnResult,
  KNOWLEDGE_OUTPUT_SCHEMA,
  type KnowledgeSnapshotContext,
  type LoadedSnapshot,
  type RunKnowledgeDeltaPassResult,
  type RunKnowledgeEnrichmentResult,
  runKnowledgeDeltaPass,
  runKnowledgeEnrichment,
} from "@rennet/core";
import type { InvocationBudget } from "@rennet/protocol";
import { execaGit, type GitExec } from "./git-range-diff";
import type { KnowledgeStore } from "./knowledge-store";
import type { ProjectContextReader } from "./project-context-reader";
import { extractClaudeUsage, type MetricsCollector } from "./turn-metrics";

/**
 * The ADAPTER side of the LLM knowledge layer (layer c, design §2b/§6): the real
 * harness call, the snapshot projection, and the initial + delta enrichment
 * orchestration. `core`'s `runKnowledgeEnrichment`/`runKnowledgeDeltaPass` are pure
 * over an INJECTED `runTurn`; this module supplies the concrete Claude turn (with
 * the knowledge output schema and, optionally, the cost-metrics tap) and the store
 * writes — keeping the model boundary exactly at this layer and off `core`.
 *
 * Every model turn runs on the user's own `claude` (subscription OAuth, $0
 * metered), budget-gated (R10), and OFF the review's critical path: the review
 * reads the model-free structural + symbolic layers; knowledge enrichment never
 * blocks it and degrades to "absent" honestly on any failure.
 */

/** Options for the knowledge enrichment session (mirrors HarnessRunTurnOptions). */
export interface KnowledgeRunTurnOptions {
  /** The read-only session's working directory (the repo root). */
  readonly cwd: string;
  readonly model?: string;
  readonly signal?: AbortSignal;
}

/**
 * Build the injected `runTurn` for a knowledge enrichment turn against a harness
 * port. Contract-identical to `createHarnessRunTurn` but constrained to the
 * KNOWLEDGE output schema (not an RSP docType). When a `collector` is given it
 * additionally records one `TurnMetric` per attempt (model/apiKeySource/tokens/
 * latency) — the same instrumentation seam the cost baseline uses, so the
 * knowledge pass's cost is measurable against the ~294K review baseline.
 */
export function createKnowledgeRunTurn(
  port: HarnessPort,
  options: KnowledgeRunTurnOptions,
  collector?: MetricsCollector,
  label = "knowledge",
  now: () => number = Date.now,
): (prompt: string, attempt: number) => Promise<HarnessTurnResult> {
  return async function runTurn(prompt: string, attempt: number): Promise<HarnessTurnResult> {
    const session = await port.createSession({
      cwd: options.cwd,
      outputSchema: KNOWLEDGE_OUTPUT_SCHEMA,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const started = now();
    let model: string | null = null;
    let apiKeySource: string | null = null;
    const record = (
      status: "emitted" | "failed",
      usage: ReturnType<typeof extractClaudeUsage>,
      error?: string,
    ): void => {
      collector?.record({
        label,
        docType: "review.hypothesis",
        attempt,
        model,
        apiKeySource,
        status,
        latencyMs: now() - started,
        usage,
        ...(error === undefined ? {} : { error }),
      });
    };
    try {
      await session.send({ prompt });
      for await (const event of session.events) {
        if (event.kind === "session.started") {
          model = event.model || null;
          apiKeySource = event.apiKeySource ?? null;
          continue;
        }
        if (event.kind === "error") {
          record("failed", null, event.error.message);
          return { status: "failed", message: event.error.message };
        }
        if (event.kind === "session.ended") {
          const usage = extractClaudeUsage(event.native);
          const outcome = event.outcome;
          if (outcome.status === "completed") {
            if (outcome.structuredOutput === undefined) {
              const message = "the harness completed the knowledge turn without structured output";
              record("failed", usage, message);
              return { status: "failed", message };
            }
            record("emitted", usage);
            return { status: "emitted", body: outcome.structuredOutput };
          }
          const message =
            outcome.status === "failed"
              ? outcome.error.message
              : "the knowledge turn was cancelled";
          record("failed", usage, message);
          return { status: "failed", message };
        }
      }
      const message = "the harness stream ended without a terminal frame";
      record("failed", null, message);
      return { status: "failed", message };
    } finally {
      await session.close();
    }
  };
}

/** Project a materialized snapshot into the compact context the enrichment reasons over. */
export function snapshotContextFromLoaded(loaded: LoadedSnapshot): KnowledgeSnapshotContext {
  return {
    repoKey: loaded.manifest.repoKey,
    baseOid: loaded.manifest.baseOid,
    snapshotFingerprint: loaded.manifest.fingerprint,
    files: loaded.files.map((file) => ({ path: file.path, blobOid: file.blobOid })),
    scopes: loaded.scopes.map((scope) => ({ name: scope.name, root: scope.root })),
  };
}

/** Shared inputs for an enrichment orchestration against a live repo. */
export interface EnrichKnowledgeDeps {
  readonly reader: ProjectContextReader;
  readonly knowledgeStore: KnowledgeStore;
  readonly port: HarnessPort;
  readonly repoKey: string;
  readonly repoRoot: string;
  /** The resolved base OID the snapshot must be fresh at. */
  readonly baseOid: string;
  /** Optional ceiling; absent means the pass is deliberately uncapped. */
  readonly budget?: InvocationBudget;
  readonly model?: string;
  readonly signal?: AbortSignal;
  readonly guidance?: string;
  readonly maxFiles?: number;
  readonly maxRetries?: number;
  /** Optional cost-metrics tap (records the knowledge turn's tokens/latency). */
  readonly collector?: MetricsCollector;
}

export type EnrichKnowledgeOutcome =
  | { readonly status: "ok" | "failed"; readonly result: RunKnowledgeEnrichmentResult }
  | { readonly status: "snapshot-unavailable"; readonly reason: string };

/**
 * Run the INITIAL knowledge enrichment for a repo and persist the set. Gates the
 * base snapshot fresh first (an absent/stale/corrupt snapshot is a typed
 * `snapshot-unavailable`, never a fabricated set), projects it, runs the bounded
 * budget-gated model turn, and — on `ok` — writes the set to the local store. A
 * failed turn leaves the store untouched (knowledge degrades to absent honestly).
 */
export async function enrichKnowledgeForRepo(
  deps: EnrichKnowledgeDeps,
): Promise<EnrichKnowledgeOutcome> {
  const gated = deps.reader.loadFresh(deps.repoKey, deps.baseOid);
  if (!gated.ok) {
    return { status: "snapshot-unavailable", reason: gated.failure.reason };
  }
  const snapshot = snapshotContextFromLoaded(gated.snapshot);
  const result = await runKnowledgeEnrichment({
    snapshot,
    provenance: { model: deps.model ?? null, apiKeySource: null },
    runTurn: createKnowledgeRunTurn(
      deps.port,
      {
        cwd: deps.repoRoot,
        ...(deps.model === undefined ? {} : { model: deps.model }),
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      },
      deps.collector,
      "knowledge.initial",
    ),
    ...(deps.budget === undefined ? {} : { budget: deps.budget }),
    ...(deps.maxRetries === undefined ? {} : { maxRetries: deps.maxRetries }),
    ...(deps.maxFiles === undefined ? {} : { maxFiles: deps.maxFiles }),
    ...(deps.guidance === undefined ? {} : { guidance: deps.guidance }),
  });
  if (result.status === "ok" && result.set) {
    deps.knowledgeStore.save(deps.repoKey, result.set);
  }
  return { status: result.status, result };
}

/** Inputs for the knowledge delta pass on a baseline advance. */
export interface KnowledgeDeltaDeps extends EnrichKnowledgeDeps {
  /** The OID the prior knowledge set was generated against (the `from` of `from..to`). */
  readonly fromOid: string;
  readonly git?: GitExec;
}

export type KnowledgeDeltaOutcome =
  | { readonly status: "ok" | "failed" | "skipped"; readonly result: RunKnowledgeDeltaPassResult }
  | { readonly status: "snapshot-unavailable"; readonly reason: string }
  | { readonly status: "no-prior-set" };

/**
 * Run the bounded knowledge DELTA pass on a baseline advance and persist the
 * merged set. Requires a prior set (nothing to delta from otherwise — the caller
 * should run the initial enrichment instead). Computes the `from..to` changed-path
 * closure via git, carries untouched statements verbatim, and re-adjudicates only
 * the changed regions in one budget-gated turn. Never blocks a review; a failed
 * turn leaves the prior set in place (still visible, R29).
 */
export async function runKnowledgeDeltaForRepo(
  deps: KnowledgeDeltaDeps,
): Promise<KnowledgeDeltaOutcome> {
  const priorSet = deps.knowledgeStore.loadLocal(deps.repoKey);
  if (!priorSet) return { status: "no-prior-set" };

  const gated = deps.reader.loadFresh(deps.repoKey, deps.baseOid);
  if (!gated.ok) {
    return { status: "snapshot-unavailable", reason: gated.failure.reason };
  }
  const snapshot = snapshotContextFromLoaded(gated.snapshot);
  const git = deps.git ?? execaGit;
  const changedPaths = await changedPathsBetween(git, deps.repoRoot, deps.fromOid, deps.baseOid);

  const result = await runKnowledgeDeltaPass({
    snapshot,
    priorSet,
    changedPaths,
    provenance: { model: deps.model ?? null, apiKeySource: null },
    runTurn: createKnowledgeRunTurn(
      deps.port,
      {
        cwd: deps.repoRoot,
        ...(deps.model === undefined ? {} : { model: deps.model }),
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      },
      deps.collector,
      "knowledge.delta",
    ),
    ...(deps.budget === undefined ? {} : { budget: deps.budget }),
    ...(deps.maxRetries === undefined ? {} : { maxRetries: deps.maxRetries }),
    ...(deps.maxFiles === undefined ? {} : { maxFiles: deps.maxFiles }),
    ...(deps.guidance === undefined ? {} : { guidance: deps.guidance }),
  });
  if (result.status === "ok" && result.set) {
    deps.knowledgeStore.save(deps.repoKey, result.set);
  }
  return { status: result.status, result };
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
