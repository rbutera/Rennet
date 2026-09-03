/**
 * The T3 leg of a council seat (t3-lens-threads 1.3).
 *
 * A board seat is a PERSISTENT thread in the daemon-owned T3 sidecar, not a cold
 * ephemeral session per attempt. Attempt 0 starts that thread's first turn; every later
 * attempt is a further turn on the SAME thread, so a repair carries only its pointers —
 * the base prompt and the draft are already in the conversation.
 *
 * The seam is structural on purpose: `adapters` may not import `server`, so the daemon's
 * `T3Client` and thread supervisor arrive as the two functions below. Nothing here
 * imports `effect` or `@t3tools/*` — the one module that may is
 * `packages/server/src/t3/client.ts`.
 */

import type { HarnessTurnResult } from "@rennet/core";
import type { CouncilEffort } from "@rennet/protocol";
import type { RunTurn } from "./council-seat-turn";
import type { ClaudeTurnUsage, MetricsCollector } from "./turn-metrics";

/** The thread a seat runs on, as the supervisor's binding reports it. */
export interface T3SeatThread {
  readonly threadId: string;
  readonly projectId: string;
}

/** What the seat leg needs from a settled T3 turn. */
export interface T3SettledTurn {
  readonly turnId: string;
  readonly state: "completed" | "interrupted" | "error";
  readonly structuredOutput?: unknown;
  readonly durationMs?: number;
  /** The provider's raw usage record, cumulative over the session on the Claude path. */
  readonly usage?: unknown;
  readonly totalCostUsd?: number;
  readonly errorMessage?: string;
  readonly thread: {
    readonly messages: readonly { readonly role: string; readonly text: string }[];
    readonly session: { readonly lastError: string | null } | null;
  };
}

/** The daemon's T3 client, narrowed to what a seat turn uses. */
export interface T3SeatClient {
  readonly startTurn: (input: {
    readonly threadId: string;
    readonly text: string;
    readonly outputSchema?: unknown;
  }) => Promise<void>;
  readonly waitForTurnSettled: (
    threadId: string,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<T3SettledTurn>;
}

/** The seam `create-server.ts` fills from the sidecar supervisor. */
export interface T3SeatSeam {
  readonly client: () => Promise<T3SeatClient>;
  /**
   * The thread bound to (this review's checkout, this generation, this seat), created on
   * first use. Idempotent, so every attempt of a seat resolves the same thread.
   */
  readonly threadFor: (input: {
    readonly seat: string;
    readonly provider: "claudeAgent" | "codex";
    readonly model: string;
  }) => Promise<T3SeatThread>;
  /** Told the seat's thread as soon as it exists, so a lane can carry the reference. The
   *  provider rides along because a lane can hold two seats (Flagged: Claude AND Codex)
   *  and the surface names which one is speaking. */
  readonly onThread?: (
    seat: string,
    thread: T3SeatThread,
    provider: "claudeAgent" | "codex",
  ) => void;
}

export interface T3SeatTurnOptions {
  readonly seat: string;
  readonly provider: "claudeAgent" | "codex";
  readonly model: string;
  readonly effort: CouncilEffort;
  readonly outputSchema: unknown;
  readonly label: string;
  readonly collector?: MetricsCollector;
  readonly signal?: AbortSignal;
}

function logSeat(label: string, line: string): void {
  console.info(`[seat] ${label} ${line}`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Claude's SDK `usage` in a streaming session is CUMULATIVE over the session's turns. */
function cumulativeUsage(usage: unknown, totalCostUsd: number | undefined): ClaudeTurnUsage | null {
  const record = asRecord(usage);
  if (!record) return null;
  const inputTokens = numberField(record, "input_tokens");
  const outputTokens = numberField(record, "output_tokens");
  const cacheReadTokens = numberField(record, "cache_read_input_tokens");
  const cacheCreationTokens = numberField(record, "cache_creation_input_tokens");
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
    reportedUsd:
      typeof totalCostUsd === "number" && Number.isFinite(totalCostUsd) ? totalCostUsd : null,
  };
}

/**
 * This turn's own spend, as the difference against what the session had already reported.
 * Recording the raw cumulative figure on a repair turn would bill the drafting turn twice.
 */
function subtractUsage(
  total: ClaudeTurnUsage | null,
  previous: ClaudeTurnUsage | null,
): ClaudeTurnUsage | null {
  if (total === null) return null;
  if (previous === null) return total;
  const at = (a: number, b: number) => Math.max(0, a - b);
  const inputTokens = at(total.inputTokens, previous.inputTokens);
  const outputTokens = at(total.outputTokens, previous.outputTokens);
  const cacheReadTokens = at(total.cacheReadTokens, previous.cacheReadTokens);
  const cacheCreationTokens = at(total.cacheCreationTokens, previous.cacheCreationTokens);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
    reportedUsd:
      total.reportedUsd === null
        ? null
        : Math.max(0, total.reportedUsd - (previous.reportedUsd ?? 0)),
  };
}

/** The last assistant message of a thread, or an empty string. */
function lastAssistantText(settled: T3SettledTurn): string {
  for (let i = settled.thread.messages.length - 1; i >= 0; i -= 1) {
    const message = settled.thread.messages[i];
    if (message?.role === "assistant") return message.text;
  }
  return "";
}

/**
 * The Codex fallback. T3 forwards a turn's schema to Codex as
 * `V2TurnStartParams.outputSchema`, but T3's Codex path does not surface a settled turn's
 * structured result the way the Claude one now does, so the JSON comes back as the final
 * message. Parsed here, for the Codex provider ONLY — a Claude turn that settled without
 * structured output is a real failure and is reported as one, never guessed at.
 */
export function parseFinalMessageJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const body = fenced?.[1]?.trim() ?? trimmed;
  const start = body.search(/[[{]/);
  if (start === -1) return undefined;
  try {
    return JSON.parse(body.slice(start));
  } catch {
    return undefined;
  }
}

/**
 * Build a seat `runTurn` on a T3 thread. Same signature as the ephemeral legs, so the
 * lint ladder in `draftOneLens` is unchanged: `attempt` 0 is the drafting turn, and every
 * later attempt is a repair turn on the same thread.
 */
export function createT3SeatTurn(
  seam: T3SeatSeam,
  options: T3SeatTurnOptions,
  now: () => number = Date.now,
): RunTurn {
  // The session's cumulative usage as of the previous turn on this thread.
  let previousUsage: ClaudeTurnUsage | null = null;
  return async function runTurn(prompt: string, attempt: number): Promise<HarnessTurnResult> {
    const started = now();
    const { label, seat, provider, model } = options;
    logSeat(label, `start attempt=${attempt} harness=t3:${provider} model=${model} seat=${seat}`);
    const record = (
      status: "emitted" | "failed",
      usage: ClaudeTurnUsage | null,
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
        model,
        // T3 runs the user's own `claude`/`codex` logins; no credential source is reported.
        apiKeySource: null,
        status,
        latencyMs: now() - started,
        usage,
        ...(error === undefined ? {} : { error }),
      });
    };
    try {
      const thread = await seam.threadFor({ seat, provider, model });
      seam.onThread?.(seat, thread, provider);
      const client = await seam.client();
      await client.startTurn({
        threadId: thread.threadId,
        text: prompt,
        // Once per turn, as the turn's structured-output contract. Never in the text.
        outputSchema: options.outputSchema,
      });
      const settled = await client.waitForTurnSettled(thread.threadId, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const cumulative = cumulativeUsage(settled.usage, settled.totalCostUsd);
      const turnUsage = subtractUsage(cumulative, previousUsage);
      previousUsage = cumulative ?? previousUsage;
      if (settled.state !== "completed") {
        const message =
          settled.errorMessage ??
          settled.thread.session?.lastError ??
          (settled.state === "interrupted"
            ? "the seat turn was interrupted"
            : "the seat turn failed");
        record("failed", turnUsage, message);
        return { status: "failed", message };
      }
      const body =
        settled.structuredOutput ??
        (provider === "codex" ? parseFinalMessageJson(lastAssistantText(settled)) : undefined);
      if (body === undefined) {
        const message =
          provider === "codex"
            ? "the Codex seat turn settled without a parseable board in its final message"
            : "the seat turn settled without structured output";
        record("failed", turnUsage, message);
        return { status: "failed", message };
      }
      record("emitted", turnUsage);
      return { status: "emitted", body, observed: { model, apiKeySource: null } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record("failed", null, message);
      return { status: "failed", message };
    }
  };
}
