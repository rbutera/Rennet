import {
  CONTEXT_ASK_OUTPUT_SCHEMA,
  type ContextAskAttempt,
  type ContextAskCost,
  type ContextAskQuery,
  type HarnessPort,
  type HarnessTurnResult,
  type RunContextAskResult,
  resolveAssignment,
  runContextAsk,
} from "@rennet/core";
import type { CouncilResolveContext, InvocationBudget } from "@rennet/protocol";
import type { KnowledgeStore } from "./knowledge-store";
import type { ResolvedRepoContext } from "./project-context-backend";
import type { ProjectContextReader } from "./project-context-reader";

// ─────────────────────────────────────────────────────────────────────────────
// The `context.ask` slice of a `CanvasOpsBackend` (issue #15). The ONE model-backed
// TOOL: it gates the snapshot fresh through the SAME fail-closed reader the other
// context reads use, loads the local knowledge set, resolves the model through the
// council's pre-declared `context-ask-fetch`/`context-ask-thorough` seats by
// `budgetHint`, and hands a concrete harness `runTurn` (constrained to the ask
// output schema) to the pure `runContextAsk` runner in `core`.
//
// The model boundary stays exactly here — `core` never imports the harness. The
// budget is METERED and REPORTED, never used to refuse (Rule Zero). A pre-turn
// failure (snapshot unavailable, no harness) is an honest `failed` ask carrying the
// routing it would have used, never a throw and never a fabricated answer.
// ─────────────────────────────────────────────────────────────────────────────

/** The `CanvasOpsBackend` accessor this adapter supplies. */
export interface ContextAskBackendPart {
  ask(query: ContextAskQuery): Promise<RunContextAskResult>;
}

/** Everything the `context.ask` slice needs, injected. */
export interface ContextAskBackendDeps {
  readonly reader: ProjectContextReader;
  readonly knowledgeStore: KnowledgeStore;
  readonly resolve: () => ResolvedRepoContext;
  /** Resolve the harness that answers (the user's own `claude`); null ⇒ honest failed ask. */
  readonly resolvePort: () => Promise<HarnessPort | null>;
  /** The read-only session's working directory (the repo root). */
  readonly repoRoot: string;
  /** The council context routing resolves against (default: claude-code installed). */
  readonly council?: CouncilResolveContext;
  /** The shared live invocation budget. Metered + reported, NEVER used to refuse. */
  readonly budget?: InvocationBudget;
  /** Records each actual ask turn in the live review's mutable run ledger. */
  readonly onAttempt?: (attempt: ContextAskAttempt) => void;
  readonly signal?: AbortSignal;
}

/** The default council availability when none is injected: the user's own claude harness. */
const DEFAULT_COUNCIL: CouncilResolveContext = { availability: { installed: ["claude-code"] } };

/**
 * Build the injected `runTurn` for one ask turn, constrained to the ask output
 * schema (mirrors `createClaudeSwarmTurn`, leaner). The council-resolved model
 * rides the session; the real model is negotiated by the harness. Any expected
 * failure (error frame, no structured output, cancellation) maps to a turn failure
 * the runner already handles.
 */
export function createContextAskRunTurn(
  port: HarnessPort,
  options: { readonly cwd: string; readonly model?: string; readonly signal?: AbortSignal },
): (prompt: string, attempt: number) => Promise<HarnessTurnResult> {
  return async function runTurn(prompt: string): Promise<HarnessTurnResult> {
    const session = await port.createSession({
      cwd: options.cwd,
      outputSchema: CONTEXT_ASK_OUTPUT_SCHEMA,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    try {
      await session.send({ prompt });
      for await (const event of session.events) {
        if (event.kind === "error") {
          return { status: "failed", message: event.error.message };
        }
        if (event.kind === "session.ended") {
          const outcome = event.outcome;
          if (outcome.status === "completed") {
            if (outcome.structuredOutput === undefined) {
              return {
                status: "failed",
                message: "the harness completed the ask turn without structured output",
              };
            }
            return { status: "emitted", body: outcome.structuredOutput };
          }
          return {
            status: "failed",
            message:
              outcome.status === "failed" ? outcome.error.message : "the ask turn was cancelled",
          };
        }
      }
      return { status: "failed", message: "the harness stream ended without a terminal frame" };
    } finally {
      await session.close();
    }
  };
}

/**
 * Build the `context.ask` backend accessor. Every call re-resolves `{repoKey,
 * baseOid}`, gates the snapshot at that OID, loads the local knowledge set,
 * resolves the routing seat, and runs the injected turn through `runContextAsk`.
 * A snapshot refusal or an absent harness is a `failed` ask (honest, carrying the
 * routing trace), never a throw.
 */
export function contextAskBackend(deps: ContextAskBackendDeps): ContextAskBackendPart {
  return {
    async ask(query: ContextAskQuery): Promise<RunContextAskResult> {
      const council = deps.council ?? DEFAULT_COUNCIL;
      const budgetHint = query.budgetHint ?? "quick";
      const jobId = budgetHint === "thorough" ? "context-ask-thorough" : "context-ask-fetch";
      const resolution = resolveAssignment(jobId, council);
      const model = resolution.kind === "model" ? resolution.model : undefined;
      const effort = resolution.kind === "model" ? resolution.effort : null;
      // The honest cost for a pre-turn failure: the routing it WOULD have used, zero turns.
      const preTurnCost: ContextAskCost = {
        turns: 0,
        model: model ?? null,
        effort,
        budgetGranted: true,
        overage: false,
        resolution: resolution.trace,
      };

      const { repoKey, baseOid } = deps.resolve();
      const gated = deps.reader.loadFresh(repoKey, baseOid);
      if (!gated.ok) {
        return {
          status: "failed",
          failureReason: `the project snapshot is ${gated.failure.reason}`,
          cost: preTurnCost,
        };
      }

      const port = await deps.resolvePort();
      if (!port) {
        return {
          status: "failed",
          failureReason: "no harness is available to answer",
          cost: preTurnCost,
        };
      }

      const knowledgeSet = deps.knowledgeStore.loadLocal(repoKey);
      const runTurn = createContextAskRunTurn(port, {
        cwd: deps.repoRoot,
        ...(model === undefined ? {} : { model }),
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      });

      return runContextAsk({
        snapshot: gated.snapshot,
        knowledgeSet,
        query,
        runTurn,
        council,
        ...(deps.budget === undefined ? {} : { budget: deps.budget }),
        ...(deps.onAttempt === undefined ? {} : { onAttempt: deps.onAttempt }),
      });
    },
  };
}
