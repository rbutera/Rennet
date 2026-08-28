/**
 * The shared fresh-capable-session turn with independent exec observation (issues
 * #179, #259, #268). Both per-finding verification (`createVerificationTurn`) and
 * verify-ui (`createUiVerificationTurn`) need the SAME thing: open a new capable
 * session (full toolset — it may read and it may RUN the code), constrain it to a
 * structured-output schema, drain to the terminal frame, and — while draining —
 * OBSERVE the exec tool calls the turn actually made as independent proof-of-run,
 * separate from whatever the model then wrote as its evidence.
 *
 * This module is that one implementation, parameterised only by the output schema
 * and a label used in the failure messages. Keeping it in ONE place means the
 * intricate paired/ambiguous exec-attribution rules (#268 F1/Gap A) cannot drift
 * between the two callers.
 */

import type {
  HarnessPort,
  ToolCall,
  ToolCallId,
  VerificationCommand,
  VerificationTurnResult,
} from "@rennet/core";

export interface ExecObservingTurnOptions {
  /** The session working directory (the review's repository root). */
  readonly cwd: string;
  /** The seat's model, when the caller pins one. */
  readonly model?: string;
  readonly signal?: AbortSignal;
  /** The structured-output JSON schema the session is constrained to. */
  readonly outputSchema: unknown;
  /** A short label for this turn kind, used in the honest failure messages (e.g. "verification"). */
  readonly label: string;
}

/** Max chars of a command's output kept as executed evidence (issue #259). */
export const EXEC_OUTPUT_TAIL = 800;

/** The command line an exec tool call ran; the Bash `command`, falling back to the tool name. */
function execCommandLine(call: ToolCall): string {
  const command = call.input.command;
  if (typeof command === "string" && command.trim().length > 0) return command;
  return call.name;
}

/** Keep the last {@link EXEC_OUTPUT_TAIL} chars — the tail is where a test/build verdict prints. */
function outputTail(text: string): string {
  return text.length <= EXEC_OUTPUT_TAIL ? text : text.slice(-EXEC_OUTPUT_TAIL);
}

/**
 * Build the fresh-session turn core injects. Each call opens a NEW CAPABLE session,
 * output-constrained to `outputSchema`, sends the prompt, drains to the terminal
 * frame, and maps it: a completed turn with `structuredOutput` is an emitted body
 * (threading the real token usage when the frame carried it); anything else is a turn
 * failure — which core turns into an honest inconclusive/unavailable, never a
 * fabricated clear. The session is always closed.
 *
 * While draining, it OBSERVES the exec tool calls the turn actually made — every
 * `tool.started` of kind `exec` paired with its `tool.output` — and threads them back
 * as the turn's `execution`. A call is only proof of a RUN once its `tool.output`
 * arrives (issue #268 F1): un-paired (denied/interrupted) calls stay separate and are
 * never reported as a clean run. A SECOND `tool.started` bearing a seen id marks the
 * record `ambiguous` (#268 Gap A): its output cannot be attributed to either command,
 * so it is excluded from BOTH `commands` and `incomplete` (fail closed). A turn that
 * ran nothing carries no `execution` at all.
 */
export function createExecObservingTurn(
  port: HarnessPort,
  options: ExecObservingTurnOptions,
): (prompt: string) => Promise<VerificationTurnResult> {
  return async function runExecObservingTurn(prompt: string): Promise<VerificationTurnResult> {
    const session = await port.createSession({
      cwd: options.cwd,
      outputSchema: options.outputSchema,
      // #585: Rennet's internal one-shot turn — never the user's session history.
      ephemeral: true,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const execByCall = new Map<
      ToolCallId,
      { command: string; ok: boolean; outputTail: string; paired: boolean; ambiguous: boolean }
    >();
    const execOrder: ToolCallId[] = [];
    try {
      await session.send({ prompt });
      for await (const event of session.events) {
        if (event.kind === "tool.started" && event.call.kind === "exec") {
          const existing = execByCall.get(event.call.id);
          if (existing) {
            existing.ambiguous = true;
          } else {
            execByCall.set(event.call.id, {
              command: execCommandLine(event.call),
              ok: false,
              outputTail: "",
              paired: false,
              ambiguous: false,
            });
            execOrder.push(event.call.id);
          }
          continue;
        }
        if (event.kind === "tool.output") {
          const record = execByCall.get(event.callId);
          if (record) {
            record.ok = event.ok;
            record.outputTail = outputTail(event.text);
            record.paired = true;
          }
          continue;
        }
        if (event.kind === "error") {
          return { status: "failed", message: event.error.message };
        }
        if (event.kind === "session.ended") {
          const outcome = event.outcome;
          if (outcome.status === "completed") {
            if (outcome.structuredOutput === undefined) {
              return {
                status: "failed",
                message: `the harness completed the ${options.label} turn without structured output`,
              };
            }
            const commands: VerificationCommand[] = [];
            const incomplete: VerificationCommand[] = [];
            for (const id of execOrder) {
              const record = execByCall.get(id);
              if (!record || record.ambiguous) continue; // ambiguous: something ran, unattributable
              const command: VerificationCommand = {
                command: record.command,
                ok: record.ok,
                outputTail: record.outputTail,
              };
              (record.paired ? commands : incomplete).push(command);
            }
            const execution =
              commands.length > 0 || incomplete.length > 0
                ? { commands, ...(incomplete.length > 0 ? { incomplete } : {}) }
                : undefined;
            return {
              status: "emitted",
              body: outcome.structuredOutput,
              ...(outcome.usage === undefined ? {} : { tokens: outcome.usage }),
              ...(execution ? { execution } : {}),
            };
          }
          if (outcome.status === "failed") {
            return { status: "failed", message: outcome.error.message };
          }
          return { status: "failed", message: `the ${options.label} turn was cancelled` };
        }
      }
      return {
        status: "failed",
        message: `the ${options.label} stream ended without a terminal frame`,
      };
    } finally {
      await session.close();
    }
  };
}
