import { describe, expect, it, vi } from "vitest";
import type { OrchestrationThread, T3Client, TurnOutcome } from "./client";
import { lastAssistantText, runHandoffTurn } from "./handoff";

// The T3 exit maps a settled T3 turn onto the handoff outcome the review loop already
// consumes. Driven with a stub client so the mapping is the thing under test; the wire
// itself is proven by client.test.ts against the real bundle.

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
  const startTurn = vi.fn(async () => undefined);
  const client = {
    startTurn,
    waitForTurnSettled: vi.fn(async () => outcome),
    readTurnDiff: vi.fn(async () => ({ turnId: outcome.turnId, turnCount: 1, ...diff })),
  } as unknown as T3Client;
  const threadFor = vi.fn(async (input: { sessionId: string; repositoryRoot: string }) => ({
    repositoryRoot: input.repositoryRoot,
    sessionId: input.sessionId,
    projectId: "p",
    threadId: "t1",
    createdAt: "now",
  }));
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
      sessionId: "rv-1",
      title: "a",
    });
    expect(startTurn).toHaveBeenCalledWith({ threadId: "t1", text: "WORK ORDER" });
    expect(outcome).toEqual({
      status: "completed",
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
