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
import { CheckpointNotReadyError } from "./client";
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
 * that exact turn. `readTurnDiff` throws a {@link CheckpointNotReadyError} while the
 * projection has not caught up, so THAT — and only that — is retried inside a bound.
 *
 * Every OTHER read failure (an RPC error, a disconnected sidecar) is NOT a late checkpoint
 * and must not be retried into silence: the earlier `.catch(() => undefined)` turned a
 * sidecar it could not reach into "the turn changed nothing", and a completed lifecycle plus
 * that empty diff shipped as a `status: "completed"` receipt with no checkpoint — the "lie in
 * the UI" family (Codex #817-2). So this returns a discriminated result: a `diff` when it read
 * one, or `unobserved` with a reason when the deadline expired still-not-ready or any other
 * read error occurred. Every settled turn eventually writes a checkpoint, so `unobserved` is
 * always a failure to observe, never a turn that legitimately did nothing.
 */
const CHECKPOINT_WAIT_MS = 10_000;
const CHECKPOINT_POLL_MS = 250;

type CheckpointObservation =
  | { readonly kind: "diff"; readonly diff: TurnDiff }
  | { readonly kind: "unobserved"; readonly reason: string };

async function readTurnDiffWhenCheckpointed(
  client: T3Client,
  threadId: string,
  turnId: string,
  options: { readonly waitMs?: number; readonly sleep?: (ms: number) => Promise<void> } = {},
): Promise<CheckpointObservation> {
  const waitMs = options.waitMs ?? CHECKPOINT_WAIT_MS;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return { kind: "diff", diff: await client.readTurnDiff(threadId, turnId) };
    } catch (error) {
      if (!(error instanceof CheckpointNotReadyError)) {
        return {
          kind: "unobserved",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      if (Date.now() >= deadline) {
        return {
          kind: "unobserved",
          reason: `no checkpoint for turn ${turnId} on thread ${threadId} within ${waitMs}ms`,
        };
      }
      await sleep(CHECKPOINT_POLL_MS);
    }
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
  // reactor's own fiber after the lifecycle settles (#811).
  const observed = await readTurnDiffWhenCheckpointed(
    client,
    binding.threadId,
    outcome.turnId,
    input.checkpointWait ?? {},
  );
  // The lifecycle settled but the checkpoint could not be observed — the deadline expired or
  // the read failed. That is a failure to OBSERVE, never a completed round with an empty diff
  // (Codex #817-2). A turn whose lifecycle already FAILED keeps its own provider reason; only a
  // COMPLETED lifecycle is turned FAILED here, because a completed receipt with no checkpoint is
  // the "lie in the UI" this closes. Either way: no fabricated diff and no checkpoint to revert.
  if (observed.kind === "unobserved") {
    const reason =
      outcome.state === "completed"
        ? `T3 turn ${outcome.turnId} on thread ${binding.threadId} settled, but its checkpoint could not be read: ${observed.reason}`
        : (outcome.thread.session?.lastError ??
          (outcome.state === "interrupted"
            ? "The T3 turn was interrupted."
            : "The T3 turn failed."));
    return { status: "failed", reason, turnDiff: "", filesTouched: [] };
  }
  const diff = observed.diff;
  const filesTouched = diff.files.map((file) => file.path);
  const turnDiff = diff.diff;
  const checkpoint = {
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
 * own attempts, and `since` drops the attempt before this one from the window.
 *
 * The caveat the prompt-matching deletion must not bury (Fable #817-6): the pick is still
 * `.at(-1)` over what survives that filter — by ARRAY ORDER, not proof. If a prior attempt's
 * turn outlived the daemon and its checkpoint settles LATE, after this attempt's `since`, both
 * rows pass the filter and the last-written wins; that is this attempt's row only when write
 * order tracks attempt order. `since` narrows the window; it does not by itself prove the last
 * row is this attempt's. The window is unchanged from before the sharing was removed.
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
  // The checkpoint IS listed on the thread; a read that throws HERE is a read FAILURE, not a
  // late checkpoint and not "no checkpoint". Let it propagate — the recovery port records
  // "its checkpoint could not be read" rather than swallowing a sidecar we could not reach into
  // "the turn left no checkpoint" (Codex #817-4). `undefined` above stays "no checkpoint".
  const diff = await client.readTurnDiff(binding.threadId, summary.turnId);
  return {
    checkpoint: { threadId: binding.threadId, turnId: diff.turnId, turnCount: diff.turnCount },
    status: summary.status,
    diff: diff.diff,
    filesTouched: diff.files.map((file) => file.path),
  };
}
