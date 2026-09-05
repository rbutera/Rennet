/**
 * Turn-level cost/latency instrumentation for the review pipeline (measurement seam).
 *
 * The three lens producers (`runFindingAngle`/`runDecisionAngle`/`runNoiseAngle`)
 * and the decomposition/ordering/narration phases each drive their model turn
 * through an injected `runTurn`. `createHarnessRunTurn` (core) supplies the real
 * Claude one; it now threads the terminal frame's `usage` through the completed
 * outcome (issue #186), but this module additionally captures the FULL measurement
 * (model + apiKeySource + wall-clock latency + reportedUsd) a baseline needs.
 *
 * This module is a drop-in instrumented `runTurn` with the SAME contract as
 * `createHarnessRunTurn`: same session drive, same result mapping, same schema
 * constraint. It ADDS a metrics tap — it reads `usage`/`total_cost_usd` off the
 * `session.ended` event's raw `native` frame (the SDK preserves it there) and the
 * `model`/`apiKeySource` off `session.started`, times the turn on the wall clock,
 * and writes one `TurnMetric` per attempt into a caller-owned `MetricsCollector`.
 *
 * It lives behind the harness (adapters), is used by the cost-baseline harness and
 * any future measurement. A turn is one `record` call; a runner's retries produce one
 * metric each, so the collector's sum is the true spend (R10: every retry is
 * money-relevant) — including a turn that THREW after its prompt was sent, which is spend
 * with no frame to read and must never be spend with no metric either.
 *
 * {@link instrumentCodexExecutor} is the same tap for the Codex utility ports, which drive
 * a `codex exec` rather than a session and so pass through none of the above.
 *
 * The usage extraction is a pure function (`extractClaudeUsage`) tested against a
 * synthetic result frame, so the parse is verified independent of a live turn.
 */

import {
  type CodexExecRequest,
  type CodexExecResult,
  type CodexExecutor,
  type HarnessPort,
  type HarnessTurnResult,
  inlineContextViolation,
  METERED_API_KEY_SOURCES,
} from "@rennet/core";
import type { GenerationUsage, RspDocType, RspTokenUsage } from "@rennet/protocol";
import { bodyJsonSchema } from "@rennet/protocol";

/** Token accounting extracted from a Claude Agent SDK `result` frame's `usage`. */
export interface ClaudeTurnUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  /** input + output + cache read + cache creation. The throughput the quota proxy sums. */
  readonly totalTokens: number;
  /**
   * The SDK's `total_cost_usd` when present. On a subscription (`oauth`/`none`)
   * session this is a DERIVED list-price figure, not money actually charged — it
   * is informational, kept distinct from "metered spend" exactly as the RSP
   * provenance keeps `reportedUsd` from `derivedUsd`. `null` when absent.
   */
  readonly reportedUsd: number | null;
}

/** One measured model turn (one attempt). A runner's retries each produce one. */
export interface TurnMetric {
  /** The logical producer this turn served, e.g. "finding" or "decomposition". */
  readonly label: string;
  /**
   * The RSP document type, when the turn emits one. Absent for a utility turn constrained
   * to an inline schema (the delta digest, refine-comment, PR-body, opener and compose
   * seats), which has no RSP doc type — `label` names those.
   */
  readonly docType?: RspDocType;
  /** The attempt index within the runner's retry loop (0 = first). */
  readonly attempt: number;
  /** The model the harness reported on `session.started`, or null if unseen. */
  readonly model: string | null;
  /** The credential source the harness reported; `oauth`/`none` are unmetered. */
  readonly apiKeySource: string | null;
  readonly status: "emitted" | "failed";
  /** Wall-clock latency from `send` to the terminal frame, milliseconds. */
  readonly latencyMs: number;
  /** Null when the turn failed before a result frame, or carried no usage. */
  readonly usage: ClaudeTurnUsage | null;
  /**
   * The bytes of context the prompt carried inline (JSON literals and fenced blocks,
   * summed), present only when over `INLINE_CONTEXT_MAX_BYTES`. Measured where the prompt
   * is sent, on every leg, and carried beside the tokens it cost so both reach one sink.
   */
  readonly inlineContextBytes?: number;
  /**
   * How many board tool calls this turn made, refusals included (`lens-board-tools` D11,
   * task 4.3). Beside the tokens and the duration, because it is the third figure a board
   * seat's cost is made of: a seat that fought the boundary twenty times spent twenty
   * tool results the diff cannot show, and a chatty seat is the named risk this whole
   * change accepted on the promise of measuring it.
   *
   * Absent — never `0` — when this turn had no board to call: a utility turn, or a seat
   * whose lane was not open. Zero is a real measurement of a seat that wrote nothing.
   */
  readonly toolCalls?: number;
  readonly error?: string;
}

/** The inline-context measurement of one prompt, shaped to spread into a `TurnMetric`. */
export function inlineContextMetric(prompt: string): { readonly inlineContextBytes?: number } {
  const inline = inlineContextViolation(prompt);
  return inline === undefined ? {} : { inlineContextBytes: inline.bytes };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function numField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Parse the `usage` block off a Claude Agent SDK `result` frame (the raw `native`
 * of a `session.ended` event). Pure and defensive: every count defaults to 0, and
 * a frame with no `usage` object returns `null` (a turn that produced no result
 * frame is not the same as one that reported zero tokens). `total_cost_usd` is
 * carried through as `reportedUsd` only when the frame supplies a number.
 */
export function extractClaudeUsage(native: unknown): ClaudeTurnUsage | null {
  const record = asRecord(native);
  if (!record) return null;
  const usage = asRecord(record.usage);
  if (!usage) return null;
  const inputTokens = numField(usage, "input_tokens");
  const outputTokens = numField(usage, "output_tokens");
  const cacheReadTokens = numField(usage, "cache_read_input_tokens");
  const cacheCreationTokens = numField(usage, "cache_creation_input_tokens");
  const costValue = record.total_cost_usd;
  const reportedUsd =
    typeof costValue === "number" && Number.isFinite(costValue) ? costValue : null;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
    reportedUsd,
  };
}

/** Render a thrown value into a metric's `error`; never throws itself. */
function describeMetricThrow(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return String(error);
  } catch {
    return "an uncoercible non-Error value";
  }
}

/** A sink the instrumented turn writes one `TurnMetric` into per attempt. */
export interface MetricsCollector {
  record(metric: TurnMetric): void;
  readonly metrics: readonly TurnMetric[];
}

export function createMetricsCollector(): MetricsCollector {
  const metrics: TurnMetric[] = [];
  return {
    record(metric: TurnMetric): void {
      metrics.push(metric);
    },
    get metrics(): readonly TurnMetric[] {
      return metrics;
    },
  };
}

/**
 * Sum a collector's turns into the generation's usage record (#737). Every recorded
 * turn counts — a failed turn that reached a result frame still billed its prompt.
 * `reportedUsd` is summed only when EVERY turn ran on a metered credential and
 * carried a figure; one subscription (`oauth`/`none`) or unpriced turn makes the
 * whole sum `null`, because a partial dollar total would read as the price of the
 * generation when it is not.
 */
export function summarizeUsage(metrics: readonly TurnMetric[]): GenerationUsage {
  const sum = {
    turns: metrics.length,
    unmeasuredTurns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
  };
  let usd: number | null = 0;
  for (const metric of metrics) {
    const usage = metric.usage;
    if (usage === null) {
      sum.unmeasuredTurns += 1;
      usd = null;
      continue;
    }
    sum.inputTokens += usage.inputTokens;
    sum.outputTokens += usage.outputTokens;
    sum.cacheReadTokens += usage.cacheReadTokens;
    sum.cacheCreationTokens += usage.cacheCreationTokens;
    sum.totalTokens += usage.totalTokens;
    const metered =
      metric.apiKeySource !== null &&
      (METERED_API_KEY_SOURCES as readonly string[]).includes(metric.apiKeySource);
    if (usd !== null && metered && usage.reportedUsd !== null) usd += usage.reportedUsd;
    else usd = null;
  }
  return { ...sum, reportedUsd: metrics.length === 0 ? null : usd };
}

/**
 * Combine a prior attempt's durable usage with the current attempt's (#741 review): a
 * re-drafting attempt adds to what the generation already spent, it does not replace
 * it. Either side `null` on price ⇒ `null`; both absent ⇒ absent.
 */
export function mergeGenerationUsage(
  prior: GenerationUsage | undefined,
  current: GenerationUsage | undefined,
): GenerationUsage | undefined {
  if (prior === undefined) return current;
  if (current === undefined) return prior;
  return {
    turns: prior.turns + current.turns,
    unmeasuredTurns: prior.unmeasuredTurns + current.unmeasuredTurns,
    inputTokens: prior.inputTokens + current.inputTokens,
    outputTokens: prior.outputTokens + current.outputTokens,
    cacheReadTokens: prior.cacheReadTokens + current.cacheReadTokens,
    cacheCreationTokens: prior.cacheCreationTokens + current.cacheCreationTokens,
    totalTokens: prior.totalTokens + current.totalTokens,
    reportedUsd:
      prior.reportedUsd === null || current.reportedUsd === null
        ? null
        : prior.reportedUsd + current.reportedUsd,
  };
}

/** A Codex turn's in-protocol token usage, in the shape the collector sums. */
function codexUsage(tokens: RspTokenUsage | undefined): ClaudeTurnUsage | null {
  if (tokens === undefined) return null;
  return {
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    cacheReadTokens: tokens.cacheRead,
    cacheCreationTokens: tokens.cacheWrite,
    totalTokens: tokens.total,
    // Codex reports no monetary figure per call; `null` keeps it out of any dollar sum
    // rather than substituting one (the RSP reportedUsd/derivedUsd discipline).
    reportedUsd: null,
  };
}

/**
 * Wrap a `CodexExecutor` so every utility send through it records one `TurnMetric`.
 *
 * The Codex utility ports (delta digest, refine comment, PR body, review opener, handoff
 * compose) call their executor directly: no session, no collector, so their sends carried
 * neither the tokens they spent nor the bytes of context they inlined to any sink, on a
 * subscription the user pays for. Wrapping the executor is the ONE place that covers all of
 * them — a port cannot opt out of its own executor — and it measures the prompt that is
 * actually sent, after the port assembled it.
 *
 * `label` names the job; `request.label` overrides it per call so one shared executor still
 * attributes its turns. A throw records a failed metric and rethrows unchanged: the port's
 * own catch still owns the honest failure.
 */
export function instrumentCodexExecutor(
  executor: CodexExecutor,
  collector: Pick<MetricsCollector, "record">,
  label: string,
  now: () => number = Date.now,
): CodexExecutor {
  return async (request: CodexExecRequest): Promise<CodexExecResult> => {
    const started = now();
    const inline = inlineContextMetric(request.prompt);
    const record = (
      status: TurnMetric["status"],
      usage: ClaudeTurnUsage | null,
      model: string,
      error?: string,
    ): void => {
      collector.record({
        label: request.label ?? label,
        attempt: 0,
        model,
        // A Codex utility seat runs on the user's own subscription; the executor reports no
        // credential source, and claiming one would make `summarizeUsage` price it.
        apiKeySource: null,
        ...inline,
        status,
        latencyMs: now() - started,
        usage,
        ...(error === undefined ? {} : { error }),
      });
    };
    try {
      const result = await executor(request);
      record("emitted", codexUsage(result.tokens), result.model ?? request.model);
      return result;
    } catch (error) {
      record("failed", null, request.model, describeMetricThrow(error));
      throw error;
    }
  };
}

export interface InstrumentedRunTurnOptions {
  readonly docType: RspDocType;
  readonly cwd: string;
  readonly model?: string;
  readonly signal?: AbortSignal;
  /** Wall clock; injectable for a deterministic unit test. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Build an instrumented `runTurn` for one document type against a harness port.
 * Contract-identical to `createHarnessRunTurn`: a fresh read-only, schema-
 * constrained session per call; a completed turn with `structuredOutput` is an
 * emitted body; anything else is a turn failure; the session is always closed.
 *
 * It additionally times the turn and records one `TurnMetric` into `collector`
 * per call — reading the model/apiKeySource off `session.started` and the token
 * usage off the `session.ended` frame's raw `native`.
 */
export function createInstrumentedRunTurn(
  port: HarnessPort,
  options: InstrumentedRunTurnOptions,
  collector: MetricsCollector,
  label: string,
): (prompt: string, attempt: number) => Promise<HarnessTurnResult> {
  const outputSchema = bodyJsonSchema(options.docType);
  const now = options.now ?? Date.now;
  return async function runTurn(prompt: string, attempt: number): Promise<HarnessTurnResult> {
    const session = await port.createSession({
      cwd: options.cwd,
      // #585: Rennet's internal one-shot turn — never the user's session history.
      ephemeral: true,
      ...(outputSchema === null ? {} : { outputSchema }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const started = now();
    const inline = inlineContextMetric(prompt);
    let model: string | null = null;
    let apiKeySource: string | null = null;
    const finish = (
      result: HarnessTurnResult,
      usage: ClaudeTurnUsage | null,
    ): HarnessTurnResult => {
      collector.record({
        label,
        docType: options.docType,
        attempt,
        model,
        apiKeySource,
        ...inline,
        status: result.status,
        latencyMs: now() - started,
        usage,
        ...(result.status === "failed" ? { error: result.message } : {}),
      });
      return result;
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
          return finish({ status: "failed", message: event.error.message }, null);
        }
        if (event.kind === "session.ended") {
          const usage = extractClaudeUsage(event.native);
          const outcome = event.outcome;
          if (outcome.status === "completed") {
            if (outcome.structuredOutput === undefined) {
              return finish(
                {
                  status: "failed",
                  message: "the harness completed the turn without structured output",
                },
                usage,
              );
            }
            return finish({ status: "emitted", body: outcome.structuredOutput }, usage);
          }
          if (outcome.status === "failed") {
            return finish({ status: "failed", message: outcome.error.message }, usage);
          }
          return finish({ status: "failed", message: "the harness turn was cancelled" }, usage);
        }
      }
      return finish(
        { status: "failed", message: "the harness stream ended without a terminal frame" },
        null,
      );
    } catch (error) {
      // The prompt was handed to the harness before this threw, so the tokens are spent
      // whether or not a frame came back. Recording nothing here was the one way a turn
      // could cost money and leave no metric — invisible spend, the failure `collector`
      // exists to prevent. One failed metric, carrying the same `inlineContextBytes`
      // measurement an emitted turn carries, then the throw continues unchanged: this is a
      // tap, not a handler, and `guardSeatTurn` upstream still owns the degradation.
      finish({ status: "failed", message: describeMetricThrow(error) }, null);
      throw error;
    } finally {
      await session.close();
    }
  };
}
