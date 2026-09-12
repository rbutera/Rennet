import { mapCouncilModel } from "@rennet/adapters";
import { type CouncilOverrideReader, councilContextFor, resolveAssignment } from "@rennet/core";
import type { CouncilHarnessId } from "@rennet/protocol";
import { type ModelSelection, modelSelection } from "./client";

// The session thread's routing (session-thread-briefing, Decision 5).
//
// The council has carried an `orchestrator-chat` job since the tables were written, with a
// pick per availability scenario, and nothing consumed it: `bindReviewThread` passed no
// model selection at all, so every review's conversation ran on the sidecar's own
// `DEFAULT_MODEL` whatever the reviewer had chosen. This is the seam that spends it, and it
// is deliberately the SAME one a board seat goes through — `resolveAssignment` to a
// provider + model + effort, then `modelSelection(...)` with `mapCouncilModel` on the Claude
// leg (create-server's `resolveT3SeatRuntime`). Two resolutions of one job is how a chat and
// a seat come to disagree about what the reviewer configured.

/** The council job the review's own conversation runs on. */
export const ORCHESTRATOR_CHAT_JOB = "orchestrator-chat" as const;

/** T3's provider instance id for a council harness. */
function providerInstance(harness: CouncilHarnessId): "claudeAgent" | "codex" | undefined {
  if (harness === "claude-code") return "claudeAgent";
  if (harness === "codex") return "codex";
  // `omp` is outside the tables and has no T3 provider; the caller falls back.
  return undefined;
}

/**
 * The model selection a session thread is created with, or `undefined` when NO INSTALLED
 * PROVIDER answers the job — the one case the bind falls back to the sidecar's default and
 * logs it (`t3code-chat-surface` spec, "No provider for the job").
 *
 * `undefined` covers three honest shapes, and all three mean the same thing to the caller:
 * nothing is installed (the council's degraded path picks a harness the host does not
 * have), the job resolves deterministically (it does not, but the union says so), or a
 * reviewer's own override names the OTHER provider's model on a single-provider host —
 * which `resolveAssignment` honours by design (#89: the harness always follows the model),
 * so the resolution is real and simply unrunnable here. Never a silent substitution: a
 * thread on a provider the reviewer did not choose is the lie this returns `undefined`
 * rather than tell.
 */
export function orchestratorChatSelection(input: {
  /** What this host actually has, honestly probed. */
  readonly installed: readonly CouncilHarnessId[];
  /** The reviewer's own role overrides, read per call (#876). */
  readonly overrides?: CouncilOverrideReader;
}): ModelSelection | undefined {
  if (input.installed.length === 0) return undefined;
  const resolution = resolveAssignment(
    ORCHESTRATOR_CHAT_JOB,
    councilContextFor(input.installed, input.overrides),
  );
  if (resolution.kind !== "model") return undefined;
  if (!input.installed.includes(resolution.harness)) return undefined;
  const instanceId = providerInstance(resolution.harness);
  if (instanceId === undefined) return undefined;
  // T3's Claude catalog uses the full model ids `mapCouncilModel` produces; its Codex
  // catalog uses the council's own names verbatim. Effort rides the selection on both.
  return modelSelection(
    instanceId,
    instanceId === "claudeAgent" ? mapCouncilModel(resolution.model) : resolution.model,
    { effort: resolution.effort },
  );
}
