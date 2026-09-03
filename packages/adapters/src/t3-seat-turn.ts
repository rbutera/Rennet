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
import { normalizeOutputSchema } from "./claude-query";
import { sanitizeSchemaForCodex, stripNullDeep } from "./codex-exec";
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
  /** T3's context-window snapshot for the turn: where Codex reports its tokens. */
  readonly tokenUsage?: unknown;
  /** The nearest earlier settled turn's usage on the thread, off the thread itself. */
  readonly previousUsage?: { readonly usage: unknown; readonly totalCostUsd?: number };
  readonly thread: {
    readonly messages: readonly { readonly role: string; readonly text: string }[];
    readonly session: { readonly lastError: string | null } | null;
  };
}

/** What starting a turn saw before dispatch; the wait uses it to tell the new turn from the last. */
export interface T3TurnStart {
  readonly previousTurnId: string | null;
  readonly requestedAt: string;
}

/** The daemon's T3 client, narrowed to what a seat turn uses. */
export interface T3SeatClient {
  readonly startTurn: (input: {
    readonly threadId: string;
    readonly text: string;
    readonly outputSchema?: unknown;
  }) => Promise<T3TurnStart>;
  readonly waitForTurnSettled: (
    threadId: string,
    options?: { readonly signal?: AbortSignal; readonly after?: T3TurnStart },
  ) => Promise<T3SettledTurn>;
  readonly interruptTurn: (threadId: string) => Promise<void>;
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
    /** The council's effort for the seat; the thread's model selection carries it. */
    readonly effort: CouncilEffort;
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

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const INTERRUPTED = "the seat turn was interrupted";
/**
 * How long an aborted turn keeps waiting for the sidecar to settle it after the interrupt
 * was sent, so the usage the turn had already billed is recorded rather than booked as
 * zero. A sidecar that never settles it is given up on after this.
 */
const INTERRUPT_SETTLE_MS = 15_000;

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
 * Codex under T3 reports on the context-window snapshot, whose `inputTokens` includes
 * the cached share (the same reconciliation `mapTokenUsageBreakdown` does for the
 * ephemeral leg). No dollar figure: T3 carries none for Codex.
 */
// ponytail: the snapshot is the LAST request's figures, not the turn's sum, so a turn
// with several tool round-trips under-reports; exact per-turn needs T3 to project
// `total`'s breakdown onto the snapshot (upstream), and then this reads that instead.
function snapshotUsage(snapshot: unknown): ClaudeTurnUsage | null {
  const record = asRecord(snapshot);
  if (!record || typeof record.usedTokens !== "number") return null;
  const cacheReadTokens = numberField(record, "cachedInputTokens");
  const inputTokens = Math.max(0, numberField(record, "inputTokens") - cacheReadTokens);
  const outputTokens = numberField(record, "outputTokens");
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens: 0,
    totalTokens: inputTokens + outputTokens + cacheReadTokens,
    reportedUsd: null,
  };
}

/**
 * This turn's own spend, as the difference against what the session had already reported.
 * Recording the raw cumulative figure on a repair turn would bill the drafting turn twice.
 * A total BELOW the previous one means the session was restarted between the turns and
 * its counter began again, so the total is the turn's own and nothing is subtracted.
 */
function subtractUsage(
  total: ClaudeTurnUsage | null,
  previous: ClaudeTurnUsage | null,
): ClaudeTurnUsage | null {
  if (total === null) return null;
  if (previous === null || total.totalTokens < previous.totalTokens) return total;
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

/**
 * A settled T3 turn's own spend. Claude reports on the settlement, cumulatively over the
 * session, so the turn's share is the difference against the previous settled turn on
 * the thread — which the settlement carries from the thread itself, so a runner
 * recreated for the thread (a whole-board restart re-resolves the seat) or a daemon
 * restarted under it subtracts exactly what one that watched every turn would. Codex
 * reports nothing on the settlement and its tokens on the context-window snapshot.
 */
export function settledTurnUsage(
  settled: Pick<T3SettledTurn, "usage" | "totalCostUsd" | "tokenUsage" | "previousUsage">,
): ClaudeTurnUsage | null {
  if (settled.usage === undefined) return snapshotUsage(settled.tokenUsage);
  const previous = settled.previousUsage;
  return subtractUsage(
    cumulativeUsage(settled.usage, settled.totalCostUsd),
    previous === undefined ? null : cumulativeUsage(previous.usage, previous.totalCostUsd),
  );
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
 * The schema each provider will actually accept (drive 1.6, 2026-09-03: every seat failed
 * in its first five seconds without this). Codex's structured outputs 400 on a typeless
 * `additionalProperties: {}` and on optional fields, which `sanitizeSchemaForCodex` has
 * reconciled for Rennet's own Codex leg since it existed; the Claude CLI's validator
 * rejects the `$schema` draft Zod projects, which `normalizeOutputSchema` strips for the
 * Claude leg. T3 forwards a schema verbatim, so the seat leg owns the same shaping.
 */
export function outputSchemaFor(provider: "claudeAgent" | "codex", schema: unknown): unknown {
  return normalizeOutputSchema(provider === "codex" ? sanitizeSchemaForCodex(schema) : schema);
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
  return async function runTurn(prompt: string, attempt: number): Promise<HarnessTurnResult> {
    const started = now();
    const { label, seat, provider, model, effort } = options;
    logSeat(
      label,
      `start attempt=${attempt} harness=t3:${provider} model=${model} effort=${effort} seat=${seat}`,
    );
    const record = (
      status: "emitted" | "failed",
      settled: T3SettledTurn | null,
      error?: string,
    ): void => {
      // The seat rides on the settle line as it does on the start line: three lenses share
      // the `board.lens-draft` label, and without it their timings cannot be told apart.
      logSeat(
        label,
        `${status} attempt=${attempt} seat=${seat} in ${now() - started} ms${error === undefined ? "" : ` (${error})`}`,
      );
      options.collector?.record({
        label,
        docType: "review.hypothesis",
        attempt,
        model,
        // T3 runs the user's own `claude`/`codex` logins; no credential source is reported.
        apiKeySource: null,
        status,
        // The provider's own clock for the turn when it reported one; the wrapper's
        // wall clock (thread binding, dispatch, the wait) only when it did not.
        latencyMs: settled?.durationMs ?? now() - started,
        usage: settled === null ? null : settledTurnUsage(settled),
        ...(error === undefined ? {} : { error }),
      });
    };
    const signal = options.signal;
    try {
      const thread = await seam.threadFor({ seat, provider, model, effort });
      seam.onThread?.(seat, thread, provider);
      const client = await seam.client();
      if (signal?.aborted) throw new Error(INTERRUPTED);
      // An abort while the model runs must reach the sidecar as an interrupt: stopping the
      // wait alone leaves the model running and spending after Rennet has moved on. The
      // interrupted turn then settles carrying what it had already billed, so the wait
      // stays open a bounded moment for that settlement. Best effort throughout — a
      // failed interrupt is logged, never thrown.
      const interrupt = () => {
        client.interruptTurn(thread.threadId).catch((error: unknown) => {
          logSeat(label, `interrupt failed (${describeError(error)})`);
        });
      };
      const stop = new AbortController();
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        interrupt();
        stopTimer ??= setTimeout(() => stop.abort(), INTERRUPT_SETTLE_MS);
      };
      signal?.addEventListener("abort", onAbort);
      let settled: T3SettledTurn;
      try {
        const start = await client.startTurn({
          threadId: thread.threadId,
          text: prompt,
          // Once per turn, as the turn's structured-output contract, shaped for the
          // provider that will validate it. Never in the text.
          outputSchema: outputSchemaFor(provider, options.outputSchema),
        });
        // Aborted while the start was in flight: the listener's interrupt may have reached
        // the sidecar before the turn existed, so send it again now that it does.
        if (signal?.aborted) interrupt();
        // Scoped to THIS start: on a repair the thread still shows the drafting turn
        // settled until the provider reports the new one, and an unscoped wait would
        // answer with the old board in milliseconds while the repair ran unwatched.
        settled = await client.waitForTurnSettled(thread.threadId, {
          after: start,
          ...(signal === undefined ? {} : { signal: stop.signal }),
        });
      } finally {
        signal?.removeEventListener("abort", onAbort);
        clearTimeout(stopTimer);
      }
      if (settled.state !== "completed") {
        const message =
          settled.errorMessage ??
          settled.thread.session?.lastError ??
          (settled.state === "interrupted" ? INTERRUPTED : "the seat turn failed");
        record("failed", settled, message);
        return { status: "failed", message };
      }
      // Codex's strict schema made every optional field required-but-nullable; strip the
      // nulls it emitted so the board parses against the original Zod shape (codex-exec
      // does the same for the ephemeral leg).
      const raw =
        settled.structuredOutput ??
        (provider === "codex" ? parseFinalMessageJson(lastAssistantText(settled)) : undefined);
      const body = provider === "codex" && raw !== undefined ? stripNullDeep(raw) : raw;
      if (body === undefined) {
        const message =
          provider === "codex"
            ? "the Codex seat turn settled without a parseable board in its final message"
            : "the seat turn settled without structured output";
        record("failed", settled, message);
        return { status: "failed", message };
      }
      record("emitted", settled);
      return { status: "emitted", body, observed: { model, apiKeySource: null } };
    } catch (error) {
      const message = signal?.aborted ? INTERRUPTED : describeError(error);
      record("failed", null, message);
      return { status: "failed", message };
    }
  };
}
