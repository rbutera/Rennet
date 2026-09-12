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

/**
 * What the session thread's routing is allowed to see, injected so the resolution is one
 * readable function rather than a lambda buried in the composition root.
 *
 * Each probe is asked FRESH on every call, which is the whole point: the first version of
 * this cached a raw `resolveProviderBinaries` result, and that probe catches each harness
 * independently and therefore answers PARTIALLY on a transient failure. One bad moment for
 * Codex discovery froze `{ claude }` for the daemon's life and routed a reviewer's stored
 * Codex choice to Claude — silently, with the cache-resetting `catch` never firing, because
 * nothing had rejected. The probes underneath memoise where memoising is correct, and the
 * bind resolves this once per THREAD, so there is nothing worth caching here.
 */
export interface SessionThreadRoutingProbes {
  /** The review's own locus-threaded Claude port, or `null`. Rejects if discovery fails. */
  readonly claudeAvailable: (repoRoot: string) => Promise<boolean>;
  /** The review's own locus-threaded Codex availability. Rejects if discovery fails. */
  readonly codexAvailable: (repoRoot: string) => Promise<boolean>;
  /** The reviewer's enable choice for the host this checkout lives on (`"claude"`/`"codex"`). */
  readonly disabledHarnesses: (repoRoot: string) => readonly string[];
  /** What the RUNNING sidecar has a binary path for — an adopted one included. */
  readonly sidecarBinaries: () => { readonly claude?: string; readonly codex?: string };
  readonly overrides?: CouncilOverrideReader;
}

/**
 * The model selection the session thread for this checkout is created with.
 *
 * A provider counts as installed only when all THREE agree, because each vetoes on its own:
 * the review's own locus-threaded probe (a WSL review is answered by the distro's
 * harnesses), the reviewer's enable choice for that host (a Codex thread on a host where
 * they turned Codex off is the surface lying about its own switch), and the running
 * sidecar's seeded binary path (the council may route the chat to Codex; a sidecar with no
 * `codex` path cannot start a Codex session).
 *
 * A probe that REJECTS answers `undefined` — the bind then falls to the sidecar's default
 * and logs it — rather than half an availability set, which is how a wrong provider gets
 * chosen confidently.
 */
export async function resolveSessionThreadModel(
  repoRoot: string,
  probes: SessionThreadRoutingProbes,
): Promise<ModelSelection | undefined> {
  let claude: boolean;
  let codex: boolean;
  try {
    [claude, codex] = await Promise.all([
      probes.claudeAvailable(repoRoot),
      probes.codexAvailable(repoRoot),
    ]);
  } catch {
    return undefined;
  }
  const disabled = new Set(probes.disabledHarnesses(repoRoot));
  const seeded = probes.sidecarBinaries();
  const installed: CouncilHarnessId[] = [];
  if (claude && !disabled.has("claude") && seeded.claude !== undefined) {
    installed.push("claude-code");
  }
  if (codex && !disabled.has("codex") && seeded.codex !== undefined) installed.push("codex");
  return orchestratorChatSelection({
    installed,
    ...(probes.overrides === undefined ? {} : { overrides: probes.overrides }),
  });
}
