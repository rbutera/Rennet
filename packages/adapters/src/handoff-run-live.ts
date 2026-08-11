import type { HandoffRunOutcome, HandoffRunPort, HarnessPort } from "@rennet/core";

// ─────────────────────────────────────────────────────────────────────────────
// review.handoff.run — the LIVE write-enabled turn (issue #18).
//
// The structural sibling of `claudeRefinePort`, but WRITE-enabled: one `claude`
// session with `readOnly: false` over the reviewed repo root, handed the bundle
// prompt. The SDK's `query()` drives the whole agentic loop internally (read, edit,
// finish) in that one turn, so a single `send()` addresses every disposition.
//
// ⛔ R33 — Rennet never pushes source code — is upheld STRUCTURALLY here: the tool
// policy allows the file read/write tools and DENIES every exec/network tool, so the
// agent physically cannot run `git push` (or any shell). The allowlist pre-approves
// the write tools (no human sits behind this headless session to approve prompts);
// the denylist is the belt-and-suspenders that makes exec unreachable rather than
// merely un-approved.
//
// A failed/unavailable turn NEVER fabricates success — it returns the honest failure
// the core orchestrator surfaces, and no patchset is captured from a turn that did
// not complete.
// ─────────────────────────────────────────────────────────────────────────────

/** The file read/write tools the coding agent may use — NO exec, NO network. */
export const HANDOFF_WRITE_TOOLS: readonly string[] = [
  "Read",
  "Grep",
  "Glob",
  "LS",
  "Write",
  "Edit",
  "MultiEdit",
];

/**
 * The exec/network tools the write session DENIES by policy — so the agent can edit
 * files but cannot push, fetch, spawn a subagent, or run arbitrary shell. `Bash` is
 * the one that could `git push`; denying it is the structural half of R33.
 */
export const HANDOFF_DENIED_TOOLS: readonly string[] = [
  "Bash",
  "BashOutput",
  "KillShell",
  "NotebookEdit",
  "Task",
  "WebFetch",
  "WebSearch",
];

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
 * `readOnly: false` session per run, tool-gated to file writes with exec/network
 * denied. The drain mirrors `createHarnessRunTurn`: a completed outcome emits the
 * final text (+ usage when reported); a construction throw, an error frame, or a
 * failed/cancelled outcome is an honest turn failure. The session is always closed.
 */
export function claudeHandoffRunPort(port: HarnessPort, model?: string): HandoffRunPort {
  return async (input) => {
    let session: Awaited<ReturnType<HarnessPort["createSession"]>>;
    try {
      session = await port.createSession({
        cwd: input.cwd,
        readOnly: false,
        allowedTools: HANDOFF_WRITE_TOOLS,
        disallowedTools: HANDOFF_DENIED_TOOLS,
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
