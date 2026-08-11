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

export interface CoverageTurnOptions {
  /** The session working directory (the review's repository root). */
  readonly cwd: string;
  /** The seat's model, when the caller pins one. */
  readonly model?: string;
  readonly signal?: AbortSignal;
}

/** Build the fresh-session coverage-mapping turn core injects. */
export function createCoverageTurn(
  port: HarnessPort,
  options: CoverageTurnOptions,
): (prompt: string) => Promise<HarnessTurnResult> {
  const outputSchema = coverageMappingJsonSchema();
  return async function runCoverageTurn(prompt: string): Promise<HarnessTurnResult> {
    const session = await port.createSession({
      cwd: options.cwd,
      outputSchema,
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
                message: "the harness completed the coverage turn without structured output",
              };
            }
            return {
              status: "emitted",
              body: outcome.structuredOutput,
              ...(outcome.usage === undefined ? {} : { tokens: outcome.usage }),
            };
          }
          if (outcome.status === "failed") {
            return { status: "failed", message: outcome.error.message };
          }
          return { status: "failed", message: "the coverage turn was cancelled" };
        }
      }
      return { status: "failed", message: "the coverage stream ended without a terminal frame" };
    } finally {
      await session.close();
    }
  };
}
