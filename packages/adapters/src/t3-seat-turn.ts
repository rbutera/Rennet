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
import type { ProviderTurnSettlement, RunTurn } from "./council-seat-turn";
import { type ClaudeTurnUsage, inlineContextMetric, type MetricsCollector } from "./turn-metrics";

/** The thread a seat runs on, as the supervisor's binding reports it. */
export interface T3SeatThread {
  readonly threadId: string;
  readonly projectId: string;
  /**
   * The daemon's board server, addressed to THIS seat (`lens-board-tools` D8). Present
   * once the seat's board lane is open; absent means the lane has none, and the turn
   * names no server at all rather than an address that resolves to nothing.
   *
   * Stable across the thread's turns on purpose: both providers fix a session's MCP
   * configuration when the harness child is created, so a later turn naming a different
   * url is refused by the adapter as a mismatch rather than run against the wrong tools.
   */
  readonly boardServer?: SeatBoardMcpServer;
}

/** One named MCP server on a turn: where it is, and which variable holds its credential. */
export interface SeatBoardMcpServer {
  readonly name: string;
  readonly url: string;
  /**
   * The environment variable the harness child reads the credential OUT OF. The value
   * never travels here: the command is written to the sidecar's event store and Claude's
   * SDK puts its whole MCP option on the child's argument list.
   */
  readonly bearerTokenEnvVar: string;
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
  readonly startTurn: (
    input: {
      readonly threadId: string;
      readonly text: string;
      readonly outputSchema?: unknown;
      /** By name; each names the environment variable holding its credential, never the credential. */
      readonly mcpServers?: Readonly<
        Record<string, { readonly url: string; readonly bearerTokenEnvVar?: string }>
      >;
    },
    options?: { readonly signal?: AbortSignal },
  ) => Promise<T3TurnStart>;
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
  /**
   * The turn's structured-output contract, when the turn HAS one.
   *
   * `undefined` is the board seat since `lens-board-tools` 3.2: a seat that writes its
   * board through tools returns no document, so no schema is attached to its turn, none
   * appears in its prompt, and its final assistant message is prose or nothing. A turn
   * that settles without structured output is then an ordinary completed turn rather
   * than the failure a document-returning seat's empty settlement is.
   *
   * Absent is not the same as `null` or `{}`: those would still travel as a contract the
   * provider validates against. Nothing travels.
   */
  readonly outputSchema?: unknown;
  readonly label: string;
  readonly collector?: MetricsCollector;
  /**
   * The seat's running board tool-call count, read once before the turn and once after,
   * so the turn's own figure is the difference (`lens-board-tools` D11, task 4.3).
   *
   * A READER, not a number: the count lives on the board this seat writes into and moves
   * while the turn runs, so a value passed in would be the count before the turn every
   * time. `undefined` — from the option or from the reader — means this seat has no board
   * to call, and the metric then carries no `toolCalls` at all rather than a zero that
   * would read as a seat that wrote nothing.
   */
  readonly toolCalls?: () => number | undefined;
  readonly signal?: AbortSignal;
  /** Content-free provider settlement, the same milestone the ephemeral legs emit. The
   *  round-report's diagnostic stream reads it, and a seat leg that dropped it would make
   *  a slow sidecar turn indistinguishable from a slow host (5.7 review). */
  readonly onProviderSettled?: (milestone: ProviderTurnSettlement) => void;
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
    const inline = inlineContextMetric(prompt);
    // Read BEFORE the turn is dispatched: the board's counter is monotonic over the lane's
    // life, so this turn's own calls are what it moved by. On attempt 0 the seat has no
    // address yet and this reads `undefined`, which the difference below treats as the
    // zero it is — the seat cannot have called a board it had not been given.
    const callsBefore = options.toolCalls?.();
    const record = (
      status: "emitted" | "failed",
      settled: T3SettledTurn | null,
      error?: string,
    ): void => {
      const callsAfter = options.toolCalls?.();
      // Absent only when the seat had no board AT ALL. A seat that had one and called it
      // zero times records `0`, which is a real and interesting measurement: it is what a
      // turn that ended without writing looks like.
      const toolCalls =
        callsAfter === undefined ? undefined : Math.max(0, callsAfter - (callsBefore ?? 0));
      // The seat rides on the settle line as it does on the start line: three lenses share
      // the `board.lens-draft` label, and without it their timings cannot be told apart.
      logSeat(
        label,
        `${status} attempt=${attempt} seat=${seat} in ${now() - started} ms${toolCalls === undefined ? "" : ` tools=${toolCalls}`}${error === undefined ? "" : ` (${error})`}`,
      );
      options.collector?.record({
        label,
        docType: "review.hypothesis",
        attempt,
        model,
        // T3 runs the user's own `claude`/`codex` logins; no credential source is reported.
        apiKeySource: null,
        ...inline,
        ...(toolCalls === undefined ? {} : { toolCalls }),
        status,
        // The provider's own clock for the turn when it reported one; the wrapper's
        // wall clock (thread binding, dispatch, the wait) only when it did not.
        latencyMs: settled?.durationMs ?? now() - started,
        usage: settled === null ? null : settledTurnUsage(settled),
        ...(error === undefined ? {} : { error }),
      });
    };
    const signal = options.signal;
    let providerSettled = false;
    const settleProvider = (outcome: ProviderTurnSettlement["outcome"]): void => {
      if (providerSettled) return;
      providerSettled = true;
      try {
        options.onProviderSettled?.({
          stage: "provider-settled",
          outcome,
          elapsedMs: Math.max(0, Math.floor(now() - started)),
        });
      } catch {
        // Diagnostics never change the provider result they describe.
      }
    };
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
        const start = await client.startTurn(
          {
            threadId: thread.threadId,
            text: prompt,
            // Once per turn, as the turn's structured-output contract, shaped for the
            // provider that will validate it. Never in the text.
            //
            // OMITTED ENTIRELY when the turn has no contract (a board seat since 3.2) —
            // not sent as `undefined`, because `startTurn`'s own optional-field handling
            // is the thing under test and a key present with an undefined value is a
            // different fact from a key that is not there.
            ...(options.outputSchema === undefined
              ? {}
              : { outputSchema: outputSchemaFor(provider, options.outputSchema) }),
            // The seat's own board address, when its lane has one. The same set on every
            // turn of the thread: the provider fixed it when the child was created.
            ...(thread.boardServer === undefined
              ? {}
              : {
                  mcpServers: {
                    [thread.boardServer.name]: {
                      url: thread.boardServer.url,
                      bearerTokenEnvVar: thread.boardServer.bearerTokenEnvVar,
                    },
                  },
                }),
          },
          // The start is bounded like the wait: an abort or a stalled sidecar releases the
          // seat here instead of holding it on an RPC that never answers.
          signal === undefined ? {} : { signal },
        );
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
      settleProvider(
        settled.state === "completed"
          ? "completed"
          : settled.state === "interrupted"
            ? "cancelled"
            : "failed",
      );
      if (settled.state !== "completed") {
        const message =
          settled.errorMessage ??
          settled.thread.session?.lastError ??
          (settled.state === "interrupted" ? INTERRUPTED : "the seat turn failed");
        record("failed", settled, message);
        return { status: "failed", message };
      }
      // A turn with no structured-output contract has no body to read and no body to
      // miss (`board-tool-authoring`: "a turn that ends without one SHALL NOT be treated
      // as a failure on that ground alone"). It settled; what it DID is on its board.
      if (options.outputSchema === undefined) {
        record("emitted", settled);
        return { status: "emitted", body: undefined, observed: { model, apiKeySource: null } };
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
      settleProvider("threw");
      const message = signal?.aborted ? INTERRUPTED : describeError(error);
      record("failed", null, message);
      return { status: "failed", message };
    }
  };
}
