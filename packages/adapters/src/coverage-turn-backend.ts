/**
 * The adapter half of requirement→hunk coverage (Rai, wireframes #9 / R53): the
 * fresh model turn the pure `runCoverageMapping` runner injects. It mirrors
 * `createVerificationTurn` (#179) exactly — coverage is likewise a derived,
 * display-time judgement, not a stored RSP document — differing only in the
 * structured-output schema it constrains the session to (`coverageMappingJsonSchema`).
 *
 * Each call opens a NEW read-only session, sends the prompt, drains to the terminal
 * frame, and maps it: a completed turn with `structuredOutput` is an emitted body
 * (threading the real token usage when the frame carried it); anything else is a turn
 * failure — which core turns into an honest `failed` mapping (no chips), never a
 * fabricated coverage. The session is always closed.
 */

import type { HarnessPort, HarnessTurnResult } from "@rennet/core";
import { coverageMappingJsonSchema } from "@rennet/protocol";
import { extractClaudeUsage, type MetricsCollector } from "./turn-metrics";

export interface CoverageTurnOptions {
  /** The session working directory (the review's repository root). */
  readonly cwd: string;
  /** The seat's model, when the caller pins one. */
  readonly model?: string;
  readonly signal?: AbortSignal;
  /** The generation's spend tap; one metric per coverage turn (#741 review). */
  readonly collector?: MetricsCollector;
  /** The metrics label; defaults to "board.design-coverage". */
  readonly label?: string;
}

/** Build the fresh-session coverage-mapping turn core injects. */
export function createCoverageTurn(
  port: HarnessPort,
  options: CoverageTurnOptions,
  now: () => number = Date.now,
): (prompt: string) => Promise<HarnessTurnResult> {
  const outputSchema = coverageMappingJsonSchema();
  let attempt = 0;
  return async function runCoverageTurn(prompt: string): Promise<HarnessTurnResult> {
    const started = now();
    const thisAttempt = attempt;
    attempt += 1;
    let observedModel: string | null = null;
    let apiKeySource: string | null = null;
    // The same spend tap the seat turns feed (#741 review): a coverage-mapping turn is a
    // provider session too, and leaving it out would let the generation price itself
    // from a subset of its turns.
    const record = (
      status: "emitted" | "failed",
      usage: ReturnType<typeof extractClaudeUsage>,
      error?: string,
    ): void => {
      options.collector?.record({
        label: options.label ?? "board.design-coverage",
        docType: "review.hypothesis",
        attempt: thisAttempt,
        model: observedModel,
        apiKeySource,
        status,
        latencyMs: now() - started,
        usage,
        ...(error === undefined ? {} : { error }),
      });
    };
    const fail = (message: string, usage: ReturnType<typeof extractClaudeUsage> = null) => {
      record("failed", usage, message);
      return { status: "failed" as const, message };
    };
    const session = await port.createSession({
      cwd: options.cwd,
      outputSchema,
      // #585: Rennet's internal one-shot turn — never the user's session history.
      ephemeral: true,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    try {
      await session.send({ prompt });
      for await (const event of session.events) {
        if (event.kind === "session.started") {
          observedModel = event.model || null;
          apiKeySource = event.apiKeySource ?? null;
          continue;
        }
        if (event.kind === "error") return fail(event.error.message);
        if (event.kind === "session.ended") {
          const outcome = event.outcome;
          const usage = extractClaudeUsage(event.native);
          if (outcome.status === "completed") {
            if (outcome.structuredOutput === undefined) {
              return fail(
                "the harness completed the coverage turn without structured output",
                usage,
              );
            }
            record("emitted", usage);
            return {
              status: "emitted",
              body: outcome.structuredOutput,
              ...(outcome.usage === undefined ? {} : { tokens: outcome.usage }),
            };
          }
          if (outcome.status === "failed") return fail(outcome.error.message, usage);
          return fail("the coverage turn was cancelled", usage);
        }
      }
      return fail("the coverage stream ended without a terminal frame");
    } catch (error) {
      record("failed", null, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      await session.close();
    }
  };
}
