import { describe, expect, it, vi } from "vitest";
import type { OrchestrationThread, T3Client, TurnOutcome } from "./client";
import { lastAssistantText, readHandoffTurnCheckpoint, runHandoffTurn } from "./handoff";
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

  it("treats a missing checkpoint as an empty diff rather than a thrown handoff", async () => {
    const { client, threadFor } = stubs({
      turnId: "turn-1",
      state: "completed",
      thread: thread("completed"),
    });
    (client.readTurnDiff as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("no checkpoint"),
    );
    const outcome = await runHandoffTurn(
      { repoRoot: "/repos/a", prompt: "x", reviewId: "rv-1" },
      { client: async () => client, threadFor },
    );
    expect(outcome).toMatchObject({ status: "completed", turnDiff: "", filesTouched: [] });
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

// Restart recovery's ONLY evidence, and the thread it reads is SHARED: the interactive
// `review.handoff.run` sends turns on it too. So "which checkpoint" cannot be answered by
// time — a handoff finishing after the round started would be adopted as the round's
// receipt. It is answered by the round's own prompt, which T3 records as the turn's user
// message the moment the turn starts. Until this suite existed, deleting the filter
// outright left 76/76 green.
describe("readHandoffTurnCheckpoint", () => {
  const ROUND_PROMPT = "# Review handoff\n\nYour work order is `.rennet/context/s1/work-order.md`";
  const OTHER_PROMPT = "please also rename the helper";
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
  const message = (turnId: string, text: string) => ({ role: "user", text, turnId });

  function checkpointStubs(
    checkpoints: ReturnType<typeof summary>[],
    messages: ReturnType<typeof message>[],
  ) {
    const client = {
      readThread: vi.fn(async () => ({ checkpoints, messages }) as unknown as OrchestrationThread),
      readTurnDiff: vi.fn(async (_threadId: string, turnId: string) => ({
        turnId,
        turnCount: Number(turnId.split("-")[1]),
        diff: `diff for ${turnId}`,
        files: [{ path: `${turnId}.ts` }],
      })),
    } as unknown as T3Client;
    const threadFor = vi.fn(
      async () => ({ threadId: "t1", repositoryRoot: "/repos/a" }) as ThreadBinding,
    );
    return { client, threadFor };
  }

  const read = (stubs: ReturnType<typeof checkpointStubs>, prompt = ROUND_PROMPT, since = SINCE) =>
    readHandoffTurnCheckpoint(
      { repoRoot: "/repos/a", reviewId: "rv-1", prompt, since },
      { client: async () => stubs.client, threadFor: stubs.threadFor },
    );

  it("reads the turn whose prompt was the round's, not whichever finished last", async () => {
    // turn-4 is an INTERACTIVE handoff on the same thread. It is the newest checkpoint and
    // it is after `since`, so every time-based pick takes it — and the round then settles
    // on somebody else's work. Only the prompt tells them apart.
    const stubs = checkpointStubs(
      [
        summary("turn-2", "2026-09-04T10:00:05.000Z", "ready"),
        summary("turn-4", "2026-09-04T10:00:09.000Z", "ready"),
      ],
      [message("turn-2", ROUND_PROMPT), message("turn-4", OTHER_PROMPT)],
    );
    const found = await read(stubs);
    expect(found?.checkpoint).toEqual({ threadId: "t1", turnId: "turn-2", turnCount: 2 });
    expect(found?.diff).toBe("diff for turn-2");
  });

  it("still refuses an earlier attempt's turn with the identical prompt", async () => {
    // An identical re-dispatch sends the same text, so the prompt alone is not enough on
    // its own; `since` is the second, independent guard. The old turn is deliberately LAST
    // in array order, so position and time disagree.
    const stubs = checkpointStubs(
      [
        summary("turn-3", "2026-09-04T10:00:09.000Z", "ready"),
        summary("turn-1", "2026-09-04T09:59:59.000Z", "ready"),
      ],
      [message("turn-1", ROUND_PROMPT), message("turn-3", ROUND_PROMPT)],
    );
    expect((await read(stubs))?.checkpoint.turnId).toBe("turn-3");
  });

  it("carries T3's status through, so a failed turn cannot read as a completed one", async () => {
    const stubs = checkpointStubs(
      [summary("turn-2", "2026-09-04T10:00:05.000Z", "error")],
      [message("turn-2", ROUND_PROMPT)],
    );
    expect(await read(stubs)).toMatchObject({ status: "error", diff: "diff for turn-2" });
  });

  it("is absent when the round's turn left no checkpoint at all", async () => {
    const stubs = checkpointStubs(
      [summary("turn-4", "2026-09-04T10:00:09.000Z", "ready")],
      [message("turn-4", OTHER_PROMPT)],
    );
    expect(await read(stubs)).toBeUndefined();
  });

  it("is absent when every matching checkpoint predates the attempt", async () => {
    const stubs = checkpointStubs(
      [summary("turn-1", "2026-09-04T09:59:59.000Z", "ready")],
      [message("turn-1", ROUND_PROMPT)],
    );
    expect(await read(stubs)).toBeUndefined();
  });
});
