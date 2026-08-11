import type { HandoffRunOutcome, HandoffRunPort, HarnessPort } from "@rennet/core";

// ─────────────────────────────────────────────────────────────────────────────
// review.handoff.run — the LIVE write-enabled turn (issue #18).
//
// The sibling of `claudeRefinePort`, but WRITE-enabled: one `claude` session with
// `readOnly: false` over the reviewed repo root, handed the bundle prompt. The SDK's
// `query()` drives the whole agentic loop internally (read, edit, run tests, finish)
// in that one turn, so a single `send()` addresses every disposition.
//
// The session is FULLY CAPABLE by design (Rai's call, 2026-08-11): a coding agent
// that cannot run the tests, formatters, and linters it just changed produces worse
// code, so the write session imposes NO tool policy of its own — the model gets the
// harness's full default tool surface, Bash included.
//
// ⚠️ R33 ("Rennet never pushes source code") is therefore an INSTRUCTION carried in
// the bundle prompt ("do NOT commit, do NOT push"), NOT a structural wall: with Bash
// available the agent technically CAN run git. Rennet itself performs no push (the
// capture path only reads); the guarantee that survives an adversary is at the
// START of a run (the human authorises it, spend is disclosed) — see the consent +
// disclosure gates — not in what the model may reach after go is pressed.
//
// A failed/unavailable turn NEVER fabricates success — it returns the honest failure
// the core orchestrator surfaces.
// ─────────────────────────────────────────────────────────────────────────────

/** Render a thrown value into a turn-failure message (mirrors harness-run-turn). */
function describeThrow(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return String(error);
  } catch {
    return "an uncoercible non-Error value";
  }
}

/**
 * Build the LIVE write-enabled `HandoffRunPort` over the Claude harness adapter. One
 * `readOnly: false` session per run, with the harness's FULL default tool surface (no
 * tool policy imposed, Bash included — Rai's call). The drain mirrors
 * `createHarnessRunTurn`: a completed outcome emits the final text (+ usage when
 * reported); a construction throw, an error frame, or a failed/cancelled outcome is
 * an honest turn failure. The session is always closed.
 */
export function claudeHandoffRunPort(port: HarnessPort, model?: string): HandoffRunPort {
  return async (input) => {
    let session: Awaited<ReturnType<HarnessPort["createSession"]>>;
    try {
      session = await port.createSession({
        cwd: input.cwd,
        readOnly: false,
        ...(model === undefined ? {} : { model }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (error) {
      return {
        status: "failed",
        reason: `the handoff session failed to start: ${describeThrow(error)}`,
      };
    }
    try {
      await session.send({ prompt: input.prompt });
      for await (const event of session.events) {
        if (event.kind === "error") return { status: "failed", reason: event.error.message };
        if (event.kind === "session.ended") {
          const outcome = event.outcome;
          if (outcome.status === "completed") {
            const result: HandoffRunOutcome = {
              status: "completed",
              finalText: outcome.finalText,
              ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
            };
            return result;
          }
          if (outcome.status === "failed")
            return { status: "failed", reason: outcome.error.message };
          return { status: "failed", reason: "the handoff turn was cancelled" };
        }
      }
      return { status: "failed", reason: "the handoff turn ended without a terminal frame" };
    } catch (error) {
      return { status: "failed", reason: `the handoff turn threw: ${describeThrow(error)}` };
    } finally {
      await session.close();
    }
  };
}
