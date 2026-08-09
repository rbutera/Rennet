/**
 * The injected turn: a `HarnessPort` → `runTurn` adapter (issue #54).
 *
 * `runDecompositionAngle` (#8) and `runOrderingPass` (#9) both take an injected
 * `runTurn(prompt, attempt)` so the model wiring is the caller's, keeping those
 * modules pure and testable with a mock. This is the REAL wiring: it drives one
 * turn through a harness session and maps the session outcome into the turn
 * result those modules expect.
 *
 * It depends ONLY on the `HarnessPort` interface (this package), never on
 * `@rennet/adapters`, so `core` never imports `adapters` — the concrete Claude
 * adapter is composed by `apps/desktop` and passed in as a `HarnessPort`. The
 * session is read-only (review never writes/execs) and constrained to the
 * docType's output schema, so a completed turn carries a schema-shaped
 * `structuredOutput` the angle then validates. Anything else (no structured
 * output, a failure, a cancellation, an error frame) is a turn failure, so the
 * angle's always-present deterministic floor stands.
 */

import { bodyJsonSchema } from "@rennet/protocol";
import type { RspDocType, RspTokenUsage } from "@rennet/types";
import type { HarnessPort } from "./harness";

/** The turn result shape shared by `runDecompositionAngle` and `runOrderingPass`. */
export type HarnessTurnResult =
  | { readonly status: "emitted"; readonly body: unknown; readonly tokens?: RspTokenUsage }
  | { readonly status: "failed"; readonly message: string };

/** Render a thrown value (Error, string, or anything) into a turn-failure message. */
function describeTurnThrow(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

/**
 * Wrap an injected seat turn so a THROWN (rejected) turn is caught and mapped to
 * the returned turn-failure the seat runners already handle (issue #96).
 *
 * `createHarnessRunTurn` (and `createCodexRunTurn`) map EXPECTED failures — a
 * failed/cancelled outcome, an error frame, missing structured output — to
 * `{ status: "failed" }`, which the three seat runners
 * (`runDecompositionAngle`/`runOrderingPass`/`runRollupNarration`) already treat
 * as a turn failure and fall from to their honest never-blank floor. But a
 * CONSTRUCTION exception — e.g. `port.createSession` rejecting on a
 * session/transport error — is raised BEFORE that try/finally, so it escapes the
 * turn as a rejected promise, propagates uncaught through the seat runner and
 * `buildReviewCanvases`, and rejects the IPC handler — crashing the whole run
 * instead of degrading that one seat.
 *
 * This guard closes that hole ONCE for every seat: a thrown turn becomes a
 * `{ status: "failed" }` result, so the seat runner's existing turn-failure path
 * takes over and the seat degrades exactly as it does for a returned failure. The
 * map is PER CALL, so a throw on one attempt still lets the runner's retry loop
 * try the next attempt — identical to a returned failure. Apply it to the runTurn
 * a seat is handed, whichever harness produced it (Claude, Codex, or a mock).
 */
export function guardSeatTurn(
  runTurn: (prompt: string, attempt: number) => Promise<HarnessTurnResult>,
): (prompt: string, attempt: number) => Promise<HarnessTurnResult> {
  return async function guardedSeatTurn(
    prompt: string,
    attempt: number,
  ): Promise<HarnessTurnResult> {
    try {
      return await runTurn(prompt, attempt);
    } catch (error) {
      return {
        status: "failed",
        message: `the seat turn threw before returning a result: ${describeTurnThrow(error)}`,
      };
    }
  };
}

export interface HarnessRunTurnOptions {
  /** The document type the model emits; its schema constrains the session output. */
  readonly docType: RspDocType;
  /** The review's repository root — the read-only session's working directory. */
  readonly cwd: string;
  readonly model?: string;
  readonly signal?: AbortSignal;
}

/**
 * Build the injected `runTurn` for one document type against a harness port.
 * Each call creates a fresh read-only session (slice-1 adapters are single-turn),
 * sends the prompt, drains the event stream to the terminal frame, and maps it:
 * a completed outcome with `structuredOutput` becomes an emitted body; everything
 * else becomes a turn failure. The session is always closed.
 */
export function createHarnessRunTurn(
  port: HarnessPort,
  options: HarnessRunTurnOptions,
): (prompt: string, attempt: number) => Promise<HarnessTurnResult> {
  const outputSchema = bodyJsonSchema(options.docType);
  return async function runTurn(prompt: string): Promise<HarnessTurnResult> {
    const session = await port.createSession({
      cwd: options.cwd,
      readOnly: true,
      ...(outputSchema === null ? {} : { outputSchema }),
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
                message: "the harness completed the turn without structured output",
              };
            }
            return { status: "emitted", body: outcome.structuredOutput };
          }
          if (outcome.status === "failed") {
            return { status: "failed", message: outcome.error.message };
          }
          return { status: "failed", message: "the harness turn was cancelled" };
        }
      }
      return { status: "failed", message: "the harness stream ended without a terminal frame" };
    } finally {
      await session.close();
    }
  };
}
