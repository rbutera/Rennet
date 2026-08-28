import type {
  CiRefinementTurn,
  CiRefinementTurnResult,
  CodexExecutor,
  HarnessPort,
} from "@rennet/core";
import { CI_CLASSIFICATION_OUTPUT_SCHEMA } from "@rennet/prompts";

export interface ClaudeCiRefinementTurnOptions {
  readonly cwd: string;
  readonly model?: string;
  readonly signal?: AbortSignal;
}

export function createClaudeCiRefinementTurn(
  port: HarnessPort,
  options: ClaudeCiRefinementTurnOptions,
): CiRefinementTurn {
  return async function runCiRefinement(
    prompt: string,
    signal?: AbortSignal,
  ): Promise<CiRefinementTurnResult> {
    const session = await port.createSession({
      cwd: options.cwd,
      outputSchema: CI_CLASSIFICATION_OUTPUT_SCHEMA,
      // #585: Rennet's internal one-shot turn — never the user's session history.
      ephemeral: true,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...((signal ?? options.signal) === undefined ? {} : { signal: signal ?? options.signal }),
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
              message: "the harness completed CI classification without structured output",
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
          : { status: "failed", message: "the CI classification turn was cancelled" };
      }
      return {
        status: "failed",
        message: "the CI classification stream ended without a terminal frame",
      };
    } finally {
      await session.close();
    }
  };
}

export function createCodexCiRefinementTurn(
  executor: CodexExecutor,
  options: { readonly model: string; readonly effort: string },
): CiRefinementTurn {
  return async function runCiRefinement(
    prompt: string,
    signal?: AbortSignal,
  ): Promise<CiRefinementTurnResult> {
    try {
      const result = await executor({
        model: options.model,
        effort: options.effort,
        prompt,
        outputSchema: CI_CLASSIFICATION_OUTPUT_SCHEMA,
        ...(signal === undefined ? {} : { signal }),
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
