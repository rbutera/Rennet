// A fake T3 seat runtime for the round-level tests (session-bound-workspace 5.7).
//
// Board seats have exactly one backend now — a thread in the daemon's T3 sidecar — so a
// test that drives a real round has to give the runtime one. This serves each seat turn
// from the harness fakes those tests already write: the seam opens a thread per seat, and
// every turn on it dispatches to the fake Claude port or the fake Codex executor with the
// SEAT as the session label, which is the attribution the fakes already answer by.
//
// It is a test double for the TRANSPORT, not a model of the sidecar: it does not persist a
// conversation, so a repair turn reaching it carries pointers into a fake that has never
// seen the draft. Tests about what a repair may carry belong on the pipeline's own fake
// seam (`lens-pipeline.test.ts`), which does hold a thread.

import type { T3SeatClient, T3SeatSeam, T3SettledTurn } from "@rennet/adapters";
import type { CodexExecutor, HarnessPort } from "@rennet/core";
import type { GenerationBoards } from "./board/board-mcp-server";
import type { RoundsRuntimeDeps, T3SeatRuntime } from "./runtime/rounds";

async function claudeTurn(
  port: HarnessPort,
  input: { cwd: string; seat: string; text: string; outputSchema?: unknown },
): Promise<T3SettledTurn> {
  const session = await port.createSession({
    cwd: input.cwd,
    // The SEAT, exactly as the sidecar's `threadFor` names it. The fakes recover the lens
    // from it when a turn's prompt does not carry one.
    label: input.seat,
    ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
    model: "fake-model",
    effort: "medium",
  } as never);
  await session.send({ prompt: input.text });
  for await (const event of session.events) {
    if (event.kind !== "session.ended") continue;
    const outcome = event.outcome;
    await session.close();
    return outcome.status === "completed"
      ? {
          turnId: `${input.seat}:turn`,
          state: "completed",
          ...(outcome.structuredOutput === undefined
            ? {}
            : { structuredOutput: outcome.structuredOutput }),
          thread: { messages: [], session: null },
        }
      : {
          turnId: `${input.seat}:turn`,
          state: "error",
          errorMessage: outcome.status === "failed" ? outcome.error.message : outcome.status,
          thread: { messages: [], session: null },
        };
  }
  await session.close();
  return {
    turnId: `${input.seat}:turn`,
    state: "error",
    errorMessage: "the fake seat turn ended without a terminal frame",
    thread: { messages: [], session: null },
  };
}

/**
 * A `resolveT3Seats` that runs every board seat through the caller's own harness fakes.
 * A seat the council routed to Codex runs on the executor, one it routed to Claude on the
 * port — the same split the sidecar makes with `provider`.
 */
export function fakeT3SeatsOverPorts(
  resolveClaudePort: (repoRoot: string) => Promise<HarnessPort | null>,
  resolveCodexExecutor: (repoRoot: string) => Promise<CodexExecutor | null>,
  /** This generation's board lanes, when the test is about them. Omitted ⇒ the runtime
   *  carries none, which is the direct-call shape every other round test wants. */
  boards?: GenerationBoards,
): NonNullable<RoundsRuntimeDeps["resolveT3Seats"]> {
  return async (input): Promise<T3SeatRuntime> => {
    const providerOf = new Map<string, { seat: string; provider: "claudeAgent" | "codex" }>();
    const settled = new Map<string, T3SettledTurn>();
    const client: T3SeatClient = {
      startTurn: async ({ threadId, text, outputSchema }) => {
        const thread = providerOf.get(threadId);
        if (thread === undefined) throw new Error(`fake seat runtime: unknown thread ${threadId}`);
        const turn = await (async (): Promise<T3SettledTurn> => {
          if (thread.provider === "codex") {
            const executor = await resolveCodexExecutor(input.repoRoot);
            if (executor === null) {
              return {
                turnId: `${thread.seat}:turn`,
                state: "error",
                errorMessage: "no fake codex executor",
                thread: { messages: [], session: null },
              };
            }
            const result = await executor({
              model: "fake-model",
              effort: "medium",
              prompt: text,
              cwd: input.repoRoot,
              label: thread.seat,
              ...(outputSchema === undefined ? {} : { outputSchema }),
            } as never);
            return {
              turnId: `${thread.seat}:turn`,
              state: "completed",
              structuredOutput: result.output,
              thread: { messages: [], session: null },
            };
          }
          const port = await resolveClaudePort(input.repoRoot);
          if (port === null) {
            return {
              turnId: `${thread.seat}:turn`,
              state: "error",
              errorMessage: "no fake claude port",
              thread: { messages: [], session: null },
            };
          }
          return claudeTurn(port, {
            cwd: input.repoRoot,
            seat: thread.seat,
            text,
            ...(outputSchema === undefined ? {} : { outputSchema }),
          });
        })();
        settled.set(threadId, turn);
        return { previousTurnId: null, requestedAt: new Date().toISOString() };
      },
      waitForTurnSettled: async (threadId) => {
        const turn = settled.get(threadId);
        if (turn === undefined) throw new Error(`fake seat runtime: no turn on ${threadId}`);
        return turn;
      },
      interruptTurn: async () => undefined,
    };
    const seam: T3SeatSeam = {
      client: async () => client,
      threadFor: async ({ seat, provider }) => {
        const threadId = `${input.generationId}:${seat}`;
        providerOf.set(threadId, { seat, provider });
        return { threadId, projectId: input.sessionId };
      },
    };
    return {
      seam,
      environmentId: "fake-environment",
      ...(boards === undefined ? {} : { boards }),
      watch: () => ({ stop: () => undefined }),
    };
  };
}

/**
 * The rounds-runtime deps with a fake sidecar filled in from the harness fakes already in
 * them. One call at the composition site keeps every round test's own fixtures intact.
 */
export function withFakeT3Seats<D extends RoundsRuntimeDeps>(
  deps: D,
  boards?: GenerationBoards,
): D {
  if (deps.resolveT3Seats !== undefined) return deps;
  return {
    ...deps,
    resolveT3Seats: fakeT3SeatsOverPorts(deps.resolveClaudePort, deps.resolveCodexExecutor, boards),
  };
}
