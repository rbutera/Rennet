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
  RspTokenUsage,
} from "@rennet/protocol";
import { createT3SeatTurn, type T3SeatSeam } from "./t3-seat-turn";
import { extractClaudeUsage, inlineContextMetric, type MetricsCollector } from "./turn-metrics";

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
  /** The turn's raw response budget in UTF-8 bytes, enforced by the adapter at the
   *  transport boundary before structured-output decoding. Absent ⇒ no cap. */
  readonly outputByteCap?: number;
  /** The turn's provider-side output-token cap. Carried only on the Claude leg, which
   *  is the only transport with a knob for it; `outputByteCap` is the enforced
   *  backstop on both. Absent ⇒ no cap. */
  readonly outputTokenCap?: number;
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

/** One line per seat start and settle on the daemon's stdout (`<dataDir>/daemon.log`).
 *  Before this the log carried nothing about seats, so a hung lens and a slow lens were
 *  indistinguishable from outside the UI (2026-09-03). */
function logSeat(label: string, line: string): void {
  console.info(`[seat] ${label} ${line}`);
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
    logSeat(label, `start attempt=${attempt} harness=claude model=${model} effort=${effort}`);
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
    const inline = inlineContextMetric(prompt);
    const record = (
      status: "emitted" | "failed",
      usage: ReturnType<typeof extractClaudeUsage>,
      error?: string,
    ): void => {
      logSeat(
        label,
        `${status} attempt=${attempt} in ${now() - started} ms${error === undefined ? "" : ` (${error})`}`,
      );
      options.collector?.record({
        label,
        docType: "review.hypothesis",
        attempt,
        model: observedModel,
        apiKeySource,
        ...inline,
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
        ...(options.outputByteCap === undefined ? {} : { outputByteCap: options.outputByteCap }),
        ...(options.outputTokenCap === undefined ? {} : { outputTokenCap: options.outputTokenCap }),
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
 *
 * `outputTokenCap` is deliberately absent from the accepted options: `codex` has no
 * model-output-token parameter or config override to carry it (codex-cli 0.147.0), so
 * a Codex turn is bounded by `outputByteCap` alone. The type says so rather than a
 * comment claiming a cap that nothing applies.
 */
export function createCodexSwarmTurn(
  executor: CodexExecutor,
  model: string,
  effort: string,
  outputSchema: unknown,
  options: Pick<
    SwarmTurnOptions,
    "signal" | "cwd" | "onProviderSettled" | "outputByteCap" | "collector" | "label"
  > &
    Pick<CodexExecRequest, "mcpServers">,
  now: () => number = Date.now,
): RunTurn {
  const label = options.label ?? "council.seat";
  return async function runTurn(prompt: string, attempt: number): Promise<HarnessTurnResult> {
    const started = now();
    logSeat(label, `start attempt=${attempt} harness=codex model=${model} effort=${effort}`);
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
    // The same tap the Claude leg feeds (#737): a Codex turn is spend too. Codex reports
    // tokens with no dollar figure and no credential source, so `reportedUsd` is null and
    // the generation sum stays honest about it.
    const inline = inlineContextMetric(prompt);
    const record = (
      status: "emitted" | "failed",
      observedModel: string | null,
      tokens: RspTokenUsage | undefined,
      error?: string,
    ): void => {
      logSeat(
        label,
        `${status} attempt=${attempt} in ${now() - started} ms${error === undefined ? "" : ` (${error})`}`,
      );
      options.collector?.record({
        label,
        docType: "review.hypothesis",
        attempt,
        ...inline,
        model: observedModel,
        apiKeySource: null,
        status,
        latencyMs: now() - started,
        usage:
          tokens === undefined
            ? null
            : {
                inputTokens: tokens.input,
                outputTokens: tokens.output,
                cacheReadTokens: tokens.cacheRead,
                cacheCreationTokens: tokens.cacheWrite,
                // The shape's invariant (input + output + both caches), not the provider's
                // `total`, which may fold reasoning tokens in.
                totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
                reportedUsd: null,
              },
        ...(error === undefined ? {} : { error }),
      });
    };
    try {
      const result = await executor({
        model,
        effort,
        prompt,
        outputSchema,
        cwd: options.cwd,
        ...(options.outputByteCap === undefined ? {} : { outputByteCap: options.outputByteCap }),
        ...(options.mcpServers === undefined ? {} : { mcpServers: options.mcpServers }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      settleProvider("completed");
      record("emitted", result.model ?? model, result.tokens);
      return {
        status: "emitted",
        body: result.output,
        observed: { model: result.model ?? model, apiKeySource: null },
      };
    } catch (error) {
      settleProvider("threw");
      const message = error instanceof Error ? error.message : String(error);
      record("failed", null, undefined, message);
      return { status: "failed", message };
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
  /** The seat's raw response budget in UTF-8 bytes; both harness legs enforce it. */
  readonly outputByteCap?: number;
  /** The seat's provider-side output-token cap. Only the Claude leg can carry it —
   *  `codex` has no model-output-token parameter — so the byte cap above stays the
   *  enforced limit on both. */
  readonly outputTokenCap?: number;
  readonly onProviderSettled?: SwarmTurnOptions["onProviderSettled"];
  /**
   * The T3 sidecar seam (t3-lens-threads). Present ⇒ BOARD jobs run as turns on their
   * seat's persistent thread instead of a cold ephemeral session; the caller names which
   * seat this resolution is for. The ephemeral Claude/Codex legs stay for every other
   * job (the project scout, the repo map, utility turns).
   */
  readonly t3?: {
    readonly seat: string;
    readonly seam: T3SeatSeam;
  };
  /**
   * Why the daemon has NO seam to give (t3-lens-threads, review finding 1). T3 is the only
   * backend a board seat has — Rai's ruling — so a daemon that tried to bring the sidecar
   * up and could not says so here, and every board job fails with this reason instead of
   * silently taking an ephemeral leg that loses the thread, the transcript, the live line
   * and the same-thread repair. Absent AND no seam ⇒ nobody ever composed a sidecar (a
   * direct-call test, the scout's own deps), which is not a fallback: it is a caller that
   * has no board pipeline behind it.
   */
  readonly t3Unavailable?: string;
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

/** The board pipeline's own jobs — the ones that run as seats on the review's threads. */
function isBoardJob(jobId: CouncilJobId): boolean {
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
  // A board job with the sidecar seam present runs on its own persistent thread, on
  // whichever provider the council routed. Both providers are T3 instances there, so the
  // harness availability the council already checked is the same check.
  //
  // And when the daemon HAS a sidecar but could not bring it up, the board seat fails with
  // that reason rather than dropping to the ephemeral legs: T3 is the only backend a board
  // seat has, so a fallback here would run the lens without its thread, its transcript, its
  // live line or its same-thread repair, and say nothing about it.
  if (isBoardJob(jobId) && deps.t3 === undefined && deps.t3Unavailable !== undefined) {
    return { failure: `T3 sidecar unavailable: ${deps.t3Unavailable}` };
  }
  if (deps.t3 !== undefined && isBoardJob(jobId)) {
    const provider = resolution.harness === "codex" ? "codex" : "claudeAgent";
    return {
      harness: resolution.harness,
      model: resolution.model,
      effort: resolution.effort,
      runTurn: createT3SeatTurn(deps.t3.seam, {
        seat: deps.t3.seat,
        provider,
        model: resolution.model,
        effort: resolution.effort,
        outputSchema: schema,
        label: deps.label ?? "council.seat",
        ...(deps.collector === undefined ? {} : { collector: deps.collector }),
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      }),
    };
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
          ...(deps.outputByteCap === undefined ? {} : { outputByteCap: deps.outputByteCap }),
          ...(deps.label === undefined ? {} : { label: deps.label }),
          ...(deps.collector === undefined ? {} : { collector: deps.collector }),
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
      ...(deps.outputByteCap === undefined ? {} : { outputByteCap: deps.outputByteCap }),
      ...(deps.outputTokenCap === undefined ? {} : { outputTokenCap: deps.outputTokenCap }),
      ...(deps.label === undefined ? {} : { label: deps.label }),
      ...(deps.collector === undefined ? {} : { collector: deps.collector }),
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      ...(deps.onProviderSettled === undefined
        ? {}
        : { onProviderSettled: deps.onProviderSettled }),
    }),
  };
}
