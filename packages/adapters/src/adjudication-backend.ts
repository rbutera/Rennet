/**
 * The fresh-session adjudication turn factories (issue #41). Cross-harness adjudication
 * runs ONE turn on the seat the Model Council resolves for the `adjudication` job — a
 * fresh session with no contamination from either generating seat. The turn is a small
 * structured judgment (`{ adjudications: [...] }`), so this mirrors the CI-refinement
 * backend exactly: a Claude-port factory and a Codex-executor factory, each output-
 * constrained to the adjudication schema, so the desktop composition can build the turn
 * for whichever harness the council resolved (provenance follows the model).
 */

import type {
  AdjudicationTurn,
  AdjudicationTurnResult,
  CodexExecutor,
  HarnessPort,
} from "@rennet/core";
import { findingAdjudicationJsonSchema } from "@rennet/protocol";

export interface ClaudeAdjudicationTurnOptions {
  /** The session working directory (the review's repository root). */
  readonly cwd: string;
  /** The resolved adjudication model — by design a different family than the primary reviewer. */
  readonly model?: string;
  readonly signal?: AbortSignal;
}

/**
 * Build the Claude-port adjudication turn. Each call opens a NEW capable session (it may
 * read and run the code to settle the disagreement), output-constrained to the
 * adjudication schema, sends the prompt, drains to the terminal frame, and maps it: a
 * completed turn with `structuredOutput` is an emitted body; anything else is a failure —
 * which core turns into an honest `insufficient`, never a drop. The session is always closed.
 */
export function createClaudeAdjudicationTurn(
  port: HarnessPort,
  options: ClaudeAdjudicationTurnOptions,
): AdjudicationTurn {
  const outputSchema = findingAdjudicationJsonSchema();
  return async function runAdjudication(prompt: string): Promise<AdjudicationTurnResult> {
    const session = await port.createSession({
      cwd: options.cwd,
      outputSchema,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    try {
      await session.send({ prompt });
      for await (const event of session.events) {
        if (event.kind === "error") return { status: "failed", message: event.error.message };
        if (event.kind !== "session.ended") continue;
        if (event.outcome.status === "completed") {
          if (event.outcome.structuredOutput === undefined) {
            return {
              status: "failed",
              message: "the harness completed the adjudication turn without structured output",
            };
          }
          return {
            status: "emitted",
            body: event.outcome.structuredOutput,
            ...(event.outcome.usage === undefined ? {} : { tokens: event.outcome.usage }),
          };
        }
        return event.outcome.status === "failed"
          ? { status: "failed", message: event.outcome.error.message }
          : { status: "failed", message: "the adjudication turn was cancelled" };
      }
      return {
        status: "failed",
        message: "the adjudication stream ended without a terminal frame",
      };
    } finally {
      await session.close();
    }
  };
}

/** Build the Codex-executor adjudication turn (the single-attempt port; the caller owns retries/budget). */
export function createCodexAdjudicationTurn(
  executor: CodexExecutor,
  options: { readonly model: string; readonly effort: string },
): AdjudicationTurn {
  const outputSchema = findingAdjudicationJsonSchema();
  return async function runAdjudication(prompt: string): Promise<AdjudicationTurnResult> {
    try {
      const result = await executor({
        model: options.model,
        effort: options.effort,
        prompt,
        outputSchema,
      });
      return {
        status: "emitted",
        body: result.output,
        ...(result.tokens === undefined ? {} : { tokens: result.tokens }),
      };
    } catch (error) {
      return { status: "failed", message: error instanceof Error ? error.message : String(error) };
    }
  };
}
