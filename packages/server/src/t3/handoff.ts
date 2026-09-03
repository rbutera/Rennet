// The handoff exit (t3code-sidecar-chat group 7; t3-lens-threads 4.3). A composed work
// order runs as ONE turn on the review's bound T3 thread, full access, cwd the checkout.
// There is no other engine to choose: the `SessionTurnLoop` leg this used to sit beside is
// gone from the review handoff. The turn's diff comes from T3's own checkpoint, and
// `review.handoff.run` recaptures the checkout and offers the delta re-review as before.
// No Effect here: the client's Promise API is the seam.

import { basename } from "node:path";
import { settledTurnUsage } from "@rennet/adapters";
import type { HandoffTurnOutcome } from "@rennet/core";
import type { RspTokenUsage } from "@rennet/protocol";
import type { OrchestrationThread, T3Client, TurnOutcome } from "./client";
import type { ThreadBinding, ThreadBindingKey } from "./threads";

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
): Promise<HandoffTurnOutcome> {
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
  const diff = await client
    .readTurnDiff(binding.threadId, outcome.turnId)
    .catch(() => ({ diff: "", files: [] as ReadonlyArray<{ readonly path: string }> }));
  const filesTouched = diff.files.map((file) => file.path);
  if (outcome.state === "completed") {
    const usage = turnUsage(outcome);
    return {
      status: "completed",
      finalText: lastAssistantText(outcome.thread),
      turnDiff: diff.diff,
      filesTouched,
      ...(usage === undefined ? {} : { usage }),
    };
  }
  const reason =
    outcome.thread.session?.lastError ??
    (outcome.state === "interrupted" ? "The T3 turn was interrupted." : "The T3 turn failed.");
  return { status: "failed", reason, turnDiff: diff.diff, filesTouched };
}
