// The handoff exit (t3code-sidecar-chat group 7; t3-lens-threads 4.3). A composed work
// order runs as ONE turn on the review's bound T3 thread, full access, cwd the checkout.
// There is no other engine to choose: the `SessionTurnLoop` leg this used to sit beside is
// gone from the review handoff. The turn's diff comes from T3's own checkpoint, and
// `review.handoff.run` recaptures the checkout and offers the delta re-review as before.
// No Effect here: the client's Promise API is the seam.

import { basename } from "node:path";
import { settledTurnUsage } from "@rennet/adapters";
import type { HandoffTurnOutcome } from "@rennet/core";
import type { RoundCheckpoint, RspTokenUsage } from "@rennet/protocol";
import type { OrchestrationThread, T3Client, TurnOutcome } from "./client";
import type { ThreadBinding, ThreadBindingKey } from "./threads";

/**
 * The turn's outcome plus the SIDECAR CHECKPOINT that captured it. A round is a turn on
 * this thread (session-bound-workspace D2), so the checkpoint — not a worktree path — is
 * the round's receipt and the handle `thread.checkpoint.revert` takes. Absent when the
 * turn produced no checkpoint (it changed nothing, or it failed before one).
 */
export type T3HandoffTurnOutcome = HandoffTurnOutcome & {
  readonly checkpoint?: RoundCheckpoint;
};

/** A turn's checkpoint read back off the thread, with the diff it captured. */
export interface T3TurnCheckpointRead {
  readonly checkpoint: RoundCheckpoint;
  readonly diff: string;
  readonly filesTouched: readonly string[];
}

export interface T3HandoffInput {
  readonly repoRoot: string;
  readonly prompt: string;
  readonly reviewId: string;
  readonly signal?: AbortSignal;
}

export interface T3HandoffDeps {
  readonly client: () => Promise<T3Client>;
  readonly threadFor: (input: {
    readonly repositoryRoot: string;
    readonly key: ThreadBindingKey;
    readonly title: string;
  }) => Promise<ThreadBinding>;
}

/**
 * The handoff turn's own spend, in the shape the ephemeral leg's outcome already carries.
 * The review's thread keeps every handoff, and Claude's counter is cumulative over the
 * session, so this is the turn's delta as the seat leg computes it.
 */
function turnUsage(outcome: TurnOutcome): RspTokenUsage | undefined {
  const usage = settledTurnUsage(outcome);
  if (usage === null) return undefined;
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead: usage.cacheReadTokens,
    cacheWrite: usage.cacheCreationTokens,
    reasoning: null,
    total: usage.totalTokens,
  };
}

/** The last assistant message text of the thread, or an empty string. */
export function lastAssistantText(thread: OrchestrationThread): string {
  for (let i = thread.messages.length - 1; i >= 0; i -= 1) {
    const message = thread.messages[i];
    if (message?.role === "assistant") return message.text;
  }
  return "";
}

export async function runHandoffTurn(
  input: T3HandoffInput,
  deps: T3HandoffDeps,
): Promise<T3HandoffTurnOutcome> {
  const binding = await deps.threadFor({
    repositoryRoot: input.repoRoot,
    key: { kind: "session", sessionId: input.reviewId },
    title: basename(input.repoRoot) || "review",
  });
  const client = await deps.client();
  const start = await client.startTurn({ threadId: binding.threadId, text: input.prompt });
  // Scoped to this start: the review's thread keeps its earlier handoffs, so an unscoped
  // wait would answer a second handoff with the first one's settlement.
  const outcome = await client.waitForTurnSettled(binding.threadId, {
    after: start,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  // The diff is T3's checkpoint for that turn. A turn that produced no checkpoint (nothing
  // changed, or it failed before one) reads as an empty diff, never a thrown handoff.
  const diff = await client.readTurnDiff(binding.threadId, outcome.turnId).catch(() => undefined);
  const filesTouched = (diff?.files ?? []).map((file) => file.path);
  const turnDiff = diff?.diff ?? "";
  // The checkpoint ref the round records. Absent when the turn wrote none — that is a
  // fact about the turn, never a fabricated receipt.
  const checkpoint =
    diff === undefined
      ? {}
      : {
          checkpoint: {
            threadId: binding.threadId,
            turnId: diff.turnId,
            turnCount: diff.turnCount,
          },
        };
  if (outcome.state === "completed") {
    const usage = turnUsage(outcome);
    return {
      status: "completed",
      finalText: lastAssistantText(outcome.thread),
      turnDiff,
      filesTouched,
      ...(usage === undefined ? {} : { usage }),
      ...checkpoint,
    };
  }
  const reason =
    outcome.thread.session?.lastError ??
    (outcome.state === "interrupted" ? "The T3 turn was interrupted." : "The T3 turn failed.");
  return { status: "failed", reason, turnDiff, filesTouched, ...checkpoint };
}

/**
 * The checkpoint a turn started at or after `since` left on the review's bound thread.
 *
 * Restart recovery's only evidence (session-bound-workspace D2): the daemon can die
 * mid-turn and T3 cannot be asked whether an execution id finished, but every settled turn
 * leaves a checkpoint stamped with when it completed. `since` is the round's worker attempt
 * start, so an earlier round's checkpoint on the same thread can never be mistaken for
 * this one's. `undefined` means the turn left nothing, which is a failed round, not a
 * guessed one.
 */
export async function readHandoffTurnCheckpoint(
  input: { readonly repoRoot: string; readonly reviewId: string; readonly since: number },
  deps: T3HandoffDeps,
): Promise<T3TurnCheckpointRead | undefined> {
  const binding = await deps.threadFor({
    repositoryRoot: input.repoRoot,
    key: { kind: "session", sessionId: input.reviewId },
    title: basename(input.repoRoot) || "review",
  });
  const client = await deps.client();
  const thread = await client.readThread(binding.threadId);
  const summary = thread.checkpoints
    .filter((entry) => Date.parse(entry.completedAt) >= input.since)
    .at(-1);
  if (summary === undefined) return undefined;
  const diff = await client.readTurnDiff(binding.threadId, summary.turnId).catch(() => undefined);
  if (diff === undefined) return undefined;
  return {
    checkpoint: { threadId: binding.threadId, turnId: diff.turnId, turnCount: diff.turnCount },
    diff: diff.diff,
    filesTouched: diff.files.map((file) => file.path),
  };
}
