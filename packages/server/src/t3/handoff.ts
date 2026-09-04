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
import type { OrchestrationThread, T3Client, TurnDiff, TurnOutcome } from "./client";
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
  /**
   * T3's own verdict on the TURN, carried through unchanged. A failed turn still leaves a
   * checkpoint — `checkpointStatusFromRuntime` in the vendored `CheckpointReactor` maps a
   * failed run to `"error"` and a cancelled or interrupted one to `"missing"` — so the
   * presence of a checkpoint says the turn ENDED, never that it succeeded. Only `"ready"`
   * may settle a round as completed.
   */
  readonly status: "ready" | "missing" | "error";
  readonly diff: string;
  readonly filesTouched: readonly string[];
}

export interface T3HandoffInput {
  /** The REPOSITORY the review lives in — the thread's binding key and its T3 project. */
  readonly repoRoot: string;
  readonly prompt: string;
  readonly reviewId: string;
  readonly signal?: AbortSignal;
  /**
   * The session's bound workspace (session-bound-workspace): the turn's cwd. Absent ⇒ the
   * repository root, which is the binding for a branch review on the reviewer's own checkout.
   */
  readonly worktreePath?: string;
  /** The branch that workspace has checked out; absent for a detached PR snapshot. */
  readonly branch?: string;
  /** Test seam for the checkpoint wait; production takes the defaults. */
  readonly checkpointWait?: {
    readonly waitMs?: number;
    readonly sleep?: (ms: number) => Promise<void>;
  };
}

/**
 * A coding ROUND's turn: the same one turn, on a thread of the round's OWN
 * (round-worker-thread). `operationId` is the durable round the thread belongs to, and
 * `title` is what the reviewer reads in the thread list.
 */
export interface T3RoundTurnInput extends T3HandoffInput {
  readonly sessionId: string;
  readonly operationId: string;
  readonly title: string;
}

/**
 * The turn's checkpoint, waited for.
 *
 * T3 writes a turn's checkpoint on the CheckpointReactor's own fiber, AFTER the turn's
 * lifecycle has settled — two writes, and the wait returns on the first. Issue #811: a
 * round that had genuinely committed came back with `diff: ""`, `changedPaths: []` and no
 * checkpoint at all, while the sidecar's projection held `checkpoint_status ready` for
 * that exact turn. `readTurnDiff` throws when the thread it reads has no checkpoint for
 * the turn yet, and the `.catch(() => undefined)` around it swallowed the diff AND the
 * receipt handle `thread.checkpoint.revert` needs. So the read is retried inside a bound
 * rather than taken once against a projection that has not caught up.
 *
 * `undefined` means the turn left no checkpoint inside the bound — a fact about the turn,
 * never a fabricated receipt.
 */
const CHECKPOINT_WAIT_MS = 10_000;
const CHECKPOINT_POLL_MS = 250;

async function readTurnDiffWhenCheckpointed(
  client: T3Client,
  threadId: string,
  turnId: string,
  options: { readonly waitMs?: number; readonly sleep?: (ms: number) => Promise<void> } = {},
): Promise<TurnDiff | undefined> {
  const waitMs = options.waitMs ?? CHECKPOINT_WAIT_MS;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + waitMs;
  for (;;) {
    const diff = await client.readTurnDiff(threadId, turnId).catch(() => undefined);
    if (diff !== undefined) return diff;
    if (Date.now() >= deadline) return undefined;
    await sleep(CHECKPOINT_POLL_MS);
  }
}

export interface T3HandoffDeps {
  readonly client: () => Promise<T3Client>;
  readonly threadFor: (input: {
    readonly repositoryRoot: string;
    readonly key: ThreadBindingKey;
    readonly title: string;
    readonly worktreePath?: string;
    readonly branch?: string;
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

async function runTurnOnBoundThread(
  binding: ThreadBinding,
  input: T3HandoffInput,
  deps: T3HandoffDeps,
): Promise<T3HandoffTurnOutcome> {
  const client = await deps.client();
  const start = await client.startTurn({ threadId: binding.threadId, text: input.prompt });
  // Scoped to this start: a thread keeps its earlier turns, so an unscoped wait would
  // answer a second turn with the first one's settlement.
  const outcome = await client.waitForTurnSettled(binding.threadId, {
    after: start,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  // The diff is T3's checkpoint for that turn, waited for — the checkpoint lands on the
  // reactor's own fiber after the lifecycle settles (#811). A turn that produced no
  // checkpoint inside the bound reads as an empty diff, never a thrown handoff.
  const diff = await readTurnDiffWhenCheckpointed(
    client,
    binding.threadId,
    outcome.turnId,
    input.checkpointWait ?? {},
  );
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

export async function runHandoffTurn(
  input: T3HandoffInput,
  deps: T3HandoffDeps,
): Promise<T3HandoffTurnOutcome> {
  const binding = await deps.threadFor({
    repositoryRoot: input.repoRoot,
    key: { kind: "session", sessionId: input.reviewId },
    title: basename(input.repoRoot) || "review",
    ...(input.worktreePath === undefined ? {} : { worktreePath: input.worktreePath }),
    ...(input.branch === undefined ? {} : { branch: input.branch }),
  });
  return runTurnOnBoundThread(binding, input, deps);
}

/**
 * A coding ROUND's turn, on the round's OWN thread (round-worker-thread).
 *
 * The session's chat thread is the reviewer's conversation with Rennet; a coding agent's
 * tool calls do not belong in it, and until this change they shared one scroll. The round
 * binds `(session, operation)` instead, in the session's bound workspace, and the thread
 * is deleted with the session's others when the session is archived.
 */
export async function runRoundTurn(
  input: T3RoundTurnInput,
  deps: T3HandoffDeps,
): Promise<T3HandoffTurnOutcome> {
  const binding = await deps.threadFor({
    repositoryRoot: input.repoRoot,
    key: { kind: "round", sessionId: input.sessionId, operationId: input.operationId },
    title: input.title,
    ...(input.worktreePath === undefined ? {} : { worktreePath: input.worktreePath }),
    ...(input.branch === undefined ? {} : { branch: input.branch }),
  });
  return runTurnOnBoundThread(binding, input, deps);
}

/**
 * The checkpoint this round's turn left on the ROUND's own thread, at or after `since`.
 *
 * Restart recovery's only evidence: the daemon can die mid-turn and T3 cannot be asked
 * whether an execution id finished, but every settled turn leaves a checkpoint.
 *
 * This is a plain read of the last checkpoint, with no prompt-text matching. That matching
 * existed because the round shared the session's thread with the interactive handoff, and
 * a handoff completing after the round started would otherwise have been adopted as the
 * round's receipt. The thread is the round's now, so the only turns on it are this round's
 * own attempts — and `since` still separates a retry from the attempt before it.
 *
 * `undefined` means no such turn left a checkpoint, which is a failed round, not a guessed
 * one. The checkpoint's `status` rides back and is the caller's to honour: a FAILED turn
 * checkpoints too, so "found a checkpoint" is not "the turn worked".
 */
export async function readRoundTurnCheckpoint(
  input: {
    readonly repoRoot: string;
    readonly sessionId: string;
    readonly operationId: string;
    readonly title: string;
    readonly since: number;
    readonly worktreePath?: string;
    readonly branch?: string;
  },
  deps: T3HandoffDeps,
): Promise<T3TurnCheckpointRead | undefined> {
  const binding = await deps.threadFor({
    repositoryRoot: input.repoRoot,
    key: { kind: "round", sessionId: input.sessionId, operationId: input.operationId },
    title: input.title,
    ...(input.worktreePath === undefined ? {} : { worktreePath: input.worktreePath }),
    ...(input.branch === undefined ? {} : { branch: input.branch }),
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
    status: summary.status,
    diff: diff.diff,
    filesTouched: diff.files.map((file) => file.path),
  };
}
