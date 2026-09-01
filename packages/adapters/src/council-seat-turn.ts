import {
  type CodexExecRequest,
  type CodexExecutor,
  type HarnessPort,
  type HarnessSession,
  type HarnessTurnResult,
  resolveAssignment,
} from "@rennet/core";
import type {
  BoardCouncilJobId,
  CouncilEffort,
  CouncilHarnessId,
  CouncilJobId,
  CouncilModel,
  CouncilResolveContext,
} from "@rennet/protocol";
import { extractClaudeUsage, type MetricsCollector } from "./turn-metrics";

/**
 * Council-seat turn resolution: one council job becomes a concrete `runTurn`
 * on the harness the council resolved — the user's own `claude` for a Claude
 * seat, the codex utility executor for a Codex seat. Shared by the lens
 * pipeline's drafter seats, the project scout, and related-context retrieval;
 * the routing IS the council's, the ports are the caller's.
 */

export type RunTurn = (prompt: string, attempt: number) => Promise<HarnessTurnResult>;

/** Options shared by both concrete turn builders. */
export interface SwarmTurnOptions {
  /** The session's working directory (the repo root). Claude seats only. */
  readonly cwd: string;
  readonly signal?: AbortSignal;
  /** Optional cost-metrics tap (the same seam the cost harness reads). */
  readonly collector?: MetricsCollector;
  /** The metrics label, e.g. "board.lens-draft". */
  readonly label?: string;
  /** Content-free provider settlement, emitted before one-shot session cleanup. */
  readonly onProviderSettled?: (milestone: ProviderTurnSettlement) => void;
}

export interface ProviderTurnSettlement {
  readonly stage: "provider-settled";
  readonly outcome:
    | "completed"
    | "failed"
    | "cancelled"
    | "stream-ended-without-terminal"
    | "threw";
  readonly elapsedMs: number;
}

function nonnegativeElapsedMs(started: number, now: () => number): number {
  const elapsed = now() - started;
  return Number.isFinite(elapsed) ? Math.max(0, Math.floor(elapsed)) : 0;
}

/**
 * Build a seat `runTurn` on a Claude harness port, constrained to the given
 * output schema (schema-injected because callers run different seats through
 * it).
 */
export function createClaudeSwarmTurn(
  port: HarnessPort,
  model: string,
  effort: CouncilEffort,
  outputSchema: unknown,
  options: SwarmTurnOptions,
  now: () => number = Date.now,
): RunTurn {
  const label = options.label ?? "council.seat";
  return async function runTurn(prompt: string, attempt: number): Promise<HarnessTurnResult> {
    const started = now();
    let observedModel: string | null = null;
    let apiKeySource: string | null = null;
    let session: HarnessSession | undefined;
    let providerSettled = false;
    const settleProvider = (outcome: ProviderTurnSettlement["outcome"]): void => {
      if (providerSettled) return;
      providerSettled = true;
      try {
        options.onProviderSettled?.({
          stage: "provider-settled",
          outcome,
          elapsedMs: nonnegativeElapsedMs(started, now),
        });
      } catch {
        // Diagnostics never change the provider result they describe.
      }
    };
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
        effort,
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
          settleProvider("failed");
          record("failed", null, event.error.message);
          return { status: "failed", message: event.error.message };
        }
        if (event.kind !== "session.ended") continue;
        const outcome = event.outcome;
        settleProvider(outcome.status);
        const usage = extractClaudeUsage(event.native);
        if (outcome.status === "completed") {
          if (outcome.structuredOutput === undefined) {
            const message = "the harness completed the seat turn without structured output";
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
          outcome.status === "failed" ? outcome.error.message : "the seat turn was cancelled";
        record("failed", usage, message);
        return { status: "failed", message };
      }
      const message = "the harness stream ended without a terminal frame";
      settleProvider("stream-ended-without-terminal");
      record("failed", null, message);
      return { status: "failed", message };
    } catch (error) {
      settleProvider("threw");
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
 * Build a seat `runTurn` on the codex utility executor. The turn is ROOTED AT
 * THE CHECKOUT (`cwd`): seats read real files as evidence, so the classic
 * temp-dir utility posture would leave a Codex seat reasoning from filenames
 * alone (review P0). An executor throw is an honest turn failure.
 */
export function createCodexSwarmTurn(
  executor: CodexExecutor,
  model: string,
  effort: string,
  outputSchema: unknown,
  options: Pick<SwarmTurnOptions, "signal" | "cwd" | "onProviderSettled"> &
    Pick<CodexExecRequest, "mcpServers">,
  now: () => number = Date.now,
): RunTurn {
  return async function runTurn(prompt: string): Promise<HarnessTurnResult> {
    const started = now();
    const settleProvider = (outcome: ProviderTurnSettlement["outcome"]): void => {
      try {
        options.onProviderSettled?.({
          stage: "provider-settled",
          outcome,
          elapsedMs: nonnegativeElapsedMs(started, now),
        });
      } catch {
        // Diagnostics never change the provider result they describe.
      }
    };
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
      settleProvider("completed");
      return {
        status: "emitted",
        body: result.output,
        observed: { model: result.model ?? model, apiKeySource: null },
      };
    } catch (error) {
      settleProvider("threw");
      return { status: "failed", message: error instanceof Error ? error.message : String(error) };
    }
  };
}

/** The ports + options a council seat needs to become a concrete `runTurn`. */
export interface CouncilSeatDeps {
  readonly claudePort?: HarnessPort | null;
  readonly codexExecutor?: CodexExecutor | null;
  readonly repoRoot: string;
  readonly collector?: MetricsCollector;
  readonly signal?: AbortSignal;
  /** The metrics label for a Claude seat, e.g. "board.lens-draft". */
  readonly label?: string;
  readonly onProviderSettled?: SwarmTurnOptions["onProviderSettled"];
}

// Board-pipeline jobs run one-shot on their inlined prompt and native
// repository tools. Codex starts configured MCP servers eagerly, so these jobs
// hand it an explicit empty MCP table. This is the ONLY narrowing a council
// seat applies: Claude seats always inherit the user's own filesystem settings,
// because auth routing (e.g. a settings-env ANTHROPIC_BASE_URL credential
// proxy) lives there and skipping them breaks authentication (2026-09-01).
const CODEX_MCP_SUPPRESSED_JOB_IDS: ReadonlySet<CouncilJobId> = new Set([
  "lens-draft",
  "lens-draft-flagged",
  "lens-draft-noise",
  "board-post-process",
  "round-report",
] satisfies readonly BoardCouncilJobId[]);

function suppressesCodexMcpServers(jobId: CouncilJobId): boolean {
  return CODEX_MCP_SUPPRESSED_JOB_IDS.has(jobId);
}

/**
 * Resolve one council job to a concrete `runTurn` on the resolved harness, or
 * an honest failure reason.
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
          // Board-pipeline jobs use only their inlined prompt and
          // native repository tools. Codex starts configured MCP servers eagerly,
          // so suppress them for those jobs while unrelated Council work inherits.
          ...(suppressesCodexMcpServers(jobId) ? { mcpServers: {} } : {}),
          ...(deps.signal === undefined ? {} : { signal: deps.signal }),
          ...(deps.onProviderSettled === undefined
            ? {}
            : { onProviderSettled: deps.onProviderSettled }),
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
    runTurn: createClaudeSwarmTurn(deps.claudePort, resolution.model, resolution.effort, schema, {
      cwd: deps.repoRoot,
      ...(deps.label === undefined ? {} : { label: deps.label }),
      ...(deps.collector === undefined ? {} : { collector: deps.collector }),
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      ...(deps.onProviderSettled === undefined
        ? {}
        : { onProviderSettled: deps.onProviderSettled }),
    }),
  };
}
