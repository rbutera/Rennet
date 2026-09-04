import { describe, expect, it, vi } from "vitest";
import type { OrchestrationThread, T3Client, TurnOutcome } from "./client";
import {
  lastAssistantText,
  readRoundTurnCheckpoint,
  runHandoffTurn,
  runRoundTurn,
} from "./handoff";
import type { ThreadBinding, ThreadBindingKey } from "./threads";

// The T3 exit maps a settled T3 turn onto the handoff outcome the review loop already
// consumes. Driven with a stub client so the mapping is the thing under test; the wire
// itself is proven by client.test.ts against the real bundle.

const START = { previousTurnId: "turn-0", requestedAt: "2026-09-03T10:00:00.000Z" };

const thread = (
  state: "completed" | "error" | "interrupted",
  messages: OrchestrationThread["messages"] = [],
  lastError: string | null = null,
): OrchestrationThread =>
  ({
    id: "t1",
    latestTurn: { turnId: "turn-1", state },
    messages,
    checkpoints: [],
    session: { lastError },
  }) as unknown as OrchestrationThread;

function stubs(
  outcome: TurnOutcome,
  diff = { diff: "--- a\n+++ b\n", files: [{ path: "src/x.ts" }] },
) {
  const startTurn = vi.fn(async () => START);
  const client = {
    startTurn,
    waitForTurnSettled: vi.fn(async () => outcome),
    readTurnDiff: vi.fn(async () => ({ turnId: outcome.turnId, turnCount: 1, ...diff })),
  } as unknown as T3Client;
  const threadFor = vi.fn(
    async (input: { key: ThreadBindingKey; repositoryRoot: string }) =>
      ({
        kind: "session",
        repositoryRoot: input.repositoryRoot,
        ...(input.key.kind === "session" ? { sessionId: input.key.sessionId } : {}),
        projectId: "p",
        threadId: "t1",
        createdAt: "now",
      }) as ThreadBinding,
  );
  return { client, startTurn, threadFor };
}

describe("runHandoffTurn", () => {
  it("binds the review's thread on (repoRoot, reviewId), sends the work order as the turn, and returns T3's diff", async () => {
    const assistant = [
      { role: "user", text: "do it" },
      { role: "assistant", text: "Done: renamed x." },
    ] as unknown as OrchestrationThread["messages"];
    const { client, startTurn, threadFor } = stubs({
      turnId: "turn-1",
      state: "completed",
      thread: thread("completed", assistant),
    });
    const outcome = await runHandoffTurn(
      { repoRoot: "/repos/a", prompt: "WORK ORDER", reviewId: "rv-1" },
      { client: async () => client, threadFor },
    );
    expect(threadFor).toHaveBeenCalledWith({
      repositoryRoot: "/repos/a",
      key: { kind: "session", sessionId: "rv-1" },
      title: "a",
    });
    expect(startTurn).toHaveBeenCalledWith({ threadId: "t1", text: "WORK ORDER" });
    // The wait is scoped to this start: the review's thread keeps its earlier handoffs.
    expect(client.waitForTurnSettled).toHaveBeenCalledWith("t1", { after: START });
    expect(outcome).toEqual({
      status: "completed",
      // The round's receipt: a turn on this thread is checkpointed, and the checkpoint ref
      // is what the round account carries and what a revert takes.
      checkpoint: { threadId: "t1", turnId: "turn-1", turnCount: 1 },
      finalText: "Done: renamed x.",
      turnDiff: "--- a\n+++ b\n",
      filesTouched: ["src/x.ts"],
    });
  });

  it("reports a failed or interrupted turn as failed with T3's reason, keeping the diff it did produce", async () => {
    const { client, threadFor } = stubs(
      { turnId: "turn-1", state: "error", thread: thread("error", [], "provider crashed") },
      { diff: "partial", files: [{ path: "a" }] },
    );
    const outcome = await runHandoffTurn(
      { repoRoot: "/repos/a", prompt: "x", reviewId: "rv-1" },
      { client: async () => client, threadFor },
    );
    expect(outcome).toEqual({
      status: "failed",
      checkpoint: { threadId: "t1", turnId: "turn-1", turnCount: 1 },
      reason: "provider crashed",
      turnDiff: "partial",
      filesTouched: ["a"],
    });
    const interrupted = stubs({
      turnId: "turn-1",
      state: "interrupted",
      thread: thread("interrupted"),
    });
    expect(
      (
        await runHandoffTurn(
          { repoRoot: "/repos/a", prompt: "x", reviewId: "rv-1" },
          { client: async () => interrupted.client, threadFor: interrupted.threadFor },
        )
      ).status,
    ).toBe("failed");
  });

  it("carries the turn's own usage on a completed outcome, as the delta on the review's thread", async () => {
    const { client, threadFor } = stubs({
      turnId: "turn-2",
      state: "completed",
      thread: thread("completed"),
      // Cumulative over the session; the previous handoff on this thread is subtracted.
      usage: { input_tokens: 12_000, output_tokens: 900, cache_read_input_tokens: 4_000 },
      previousUsage: { usage: { input_tokens: 10_000, output_tokens: 500 } },
    });
    const outcome = await runHandoffTurn(
      { repoRoot: "/repos/a", prompt: "x", reviewId: "rv-1" },
      { client: async () => client, threadFor },
    );
    expect(outcome).toMatchObject({
      status: "completed",
      usage: { input: 2_000, output: 400, cacheRead: 4_000, cacheWrite: 0, total: 6_400 },
    });
    // No usage reported means no usage claimed.
    const bare = stubs({ turnId: "turn-1", state: "completed", thread: thread("completed") });
    expect(
      await runHandoffTurn(
        { repoRoot: "/repos/a", prompt: "x", reviewId: "rv-1" },
        { client: async () => bare.client, threadFor: bare.threadFor },
      ),
    ).not.toHaveProperty("usage");
  });

  // T3 writes a turn's checkpoint on the CheckpointReactor's own fiber, AFTER the turn's
  // lifecycle settles. Issue #811: the read raced that write, threw, and the `.catch` took
  // the throw as "the turn changed nothing" — losing the diff AND the checkpoint handle a
  // revert needs, over a round that had genuinely committed. So the read WAITS.
  it("waits for a checkpoint that lands after the turn settles, and keeps its diff", async () => {
    const { client, threadFor } = stubs({
      turnId: "turn-1",
      state: "completed",
      thread: thread("completed"),
    });
    (client.readTurnDiff as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("T3 thread t1 has no checkpoint for turn turn-1"),
    );
    const sleep = vi.fn(async () => {});
    const outcome = await runHandoffTurn(
      { repoRoot: "/repos/a", prompt: "x", reviewId: "rv-1", checkpointWait: { sleep } },
      { client: async () => client, threadFor },
    );
    expect(sleep).toHaveBeenCalledTimes(1);
    // Delete the wait and this reddens to `turnDiff: ""` with no checkpoint — which is
    // exactly what shipped.
    expect(outcome).toMatchObject({
      status: "completed",
      turnDiff: "--- a\n+++ b\n",
      filesTouched: ["src/x.ts"],
      checkpoint: { threadId: "t1", turnId: "turn-1", turnCount: 1 },
    });
  });

  it("treats a checkpoint that never arrives as an empty diff rather than a thrown handoff", async () => {
    const { client, threadFor } = stubs({
      turnId: "turn-1",
      state: "completed",
      thread: thread("completed"),
    });
    (client.readTurnDiff as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("no checkpoint"));
    const outcome = await runHandoffTurn(
      {
        repoRoot: "/repos/a",
        prompt: "x",
        reviewId: "rv-1",
        checkpointWait: { waitMs: 0, sleep: async () => {} },
      },
      { client: async () => client, threadFor },
    );
    expect(outcome).toMatchObject({ status: "completed", turnDiff: "", filesTouched: [] });
    expect(outcome).not.toHaveProperty("checkpoint");
  });

  it("lastAssistantText takes the LAST assistant message, not the first", () => {
    const t = thread("completed", [
      { role: "assistant", text: "first" },
      { role: "user", text: "more" },
      { role: "assistant", text: "last" },
    ] as unknown as OrchestrationThread["messages"]);
    expect(lastAssistantText(t)).toBe("last");
    expect(lastAssistantText(thread("completed"))).toBe("");
  });
});

// A ROUND runs on its OWN thread (round-worker-thread; Rai, 2026-09-04: "we should hand
// off the round to a subagent not to the main orchestrator"). The session's chat thread is
// the reviewer's conversation with Rennet; a coding agent's tool calls do not belong in it,
// and until this change they shared one scroll.
describe("runRoundTurn", () => {
  it("binds the ROUND's own thread in the bound workspace, and never the session's", async () => {
    const { client, startTurn, threadFor } = stubs({
      turnId: "turn-1",
      state: "completed",
      thread: thread("completed"),
    });
    await runRoundTurn(
      {
        repoRoot: "/repos/a",
        prompt: "WORK ORDER",
        reviewId: "rv-1",
        sessionId: "s-1",
        operationId: "op-1",
        title: "feat/x — round 2",
        worktreePath: "/worktrees/feat-x",
        branch: "feat/x",
      },
      { client: async () => client, threadFor },
    );
    expect(threadFor).toHaveBeenCalledWith({
      repositoryRoot: "/repos/a",
      key: { kind: "round", sessionId: "s-1", operationId: "op-1" },
      title: "feat/x — round 2",
      worktreePath: "/worktrees/feat-x",
      branch: "feat/x",
    });
    // The load-bearing negative: NO turn is ever asked for on the session's key. Give the
    // round the session key back and this reddens while every other assertion still passes.
    const keys = threadFor.mock.calls.map(([call]) => call.key.kind);
    expect(keys).toEqual(["round"]);
    expect(startTurn).toHaveBeenCalledWith({ threadId: "t1", text: "WORK ORDER" });
  });
});

// Restart recovery's ONLY evidence. The thread is the ROUND's own now, so the only turns on
// it are this round's own attempts and the read is a plain "last checkpoint at or after this
// attempt started" — the prompt-text matching that guarded a SHARED thread is gone with the
// sharing. `since` is what still separates a retry from the attempt before it.
describe("readRoundTurnCheckpoint", () => {
  const SINCE = Date.parse("2026-09-04T10:00:00.000Z");

  const summary = (turnId: string, completedAt: string, status: "ready" | "error" | "missing") => ({
    turnId,
    checkpointTurnCount: Number(turnId.split("-")[1]),
    checkpointRef: `refs/t3/checkpoints/${turnId}`,
    status,
    files: [{ path: `${turnId}.ts` }],
    assistantMessageId: null,
    completedAt,
  });

  function checkpointStubs(checkpoints: ReturnType<typeof summary>[]) {
    const seen: ThreadBindingKey[] = [];
    const client = {
      readThread: vi.fn(
        async () => ({ checkpoints, messages: [] }) as unknown as OrchestrationThread,
      ),
      readTurnDiff: vi.fn(async (_threadId: string, turnId: string) => ({
        turnId,
        turnCount: Number(turnId.split("-")[1]),
        diff: `diff for ${turnId}`,
        files: [{ path: `${turnId}.ts` }],
      })),
    } as unknown as T3Client;
    const threadFor = vi.fn(async (input: { key: ThreadBindingKey }) => {
      seen.push(input.key);
      return { threadId: "t1", repositoryRoot: "/repos/a" } as ThreadBinding;
    });
    return { client, threadFor, seen };
  }

  const read = (stubs: ReturnType<typeof checkpointStubs>, since = SINCE) =>
    readRoundTurnCheckpoint(
      {
        repoRoot: "/repos/a",
        sessionId: "s-1",
        operationId: "op-1",
        title: "feat/x — round 2",
        since,
      },
      { client: async () => stubs.client, threadFor: stubs.threadFor },
    );

  it("reads the ROUND's thread, not the session's", async () => {
    const stubs = checkpointStubs([summary("turn-2", "2026-09-04T10:00:05.000Z", "ready")]);
    await read(stubs);
    expect(stubs.seen).toEqual([{ kind: "round", sessionId: "s-1", operationId: "op-1" }]);
  });

  it("refuses an earlier attempt's turn on the same thread", async () => {
    // An identical re-dispatch reuses this thread, so `since` is the guard. The old turn is
    // deliberately LAST in array order, so position and time disagree.
    const stubs = checkpointStubs([
      summary("turn-3", "2026-09-04T10:00:09.000Z", "ready"),
      summary("turn-1", "2026-09-04T09:59:59.000Z", "ready"),
    ]);
    expect((await read(stubs))?.checkpoint.turnId).toBe("turn-3");
  });

  it("carries T3's status through, so a failed turn cannot read as a completed one", async () => {
    const stubs = checkpointStubs([summary("turn-2", "2026-09-04T10:00:05.000Z", "error")]);
    expect(await read(stubs)).toMatchObject({ status: "error", diff: "diff for turn-2" });
  });

  it("is absent when every checkpoint predates the attempt", async () => {
    const stubs = checkpointStubs([summary("turn-1", "2026-09-04T09:59:59.000Z", "ready")]);
    expect(await read(stubs)).toBeUndefined();
  });
});
