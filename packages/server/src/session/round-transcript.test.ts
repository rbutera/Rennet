import type { RoundOperation } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { roundDispatchTranscriptRow, roundReturnTranscriptRow } from "./round-transcript";

const baseOperation: Omit<RoundOperation, "state"> = {
  operationId: "operation-1",
  sessionId: "session-1",
  reviewId: "review-1",
  dispatchId: "dispatch-1",
  sourcePatchsetId: "patchset-1",
  askOccurrences: [
    { id: "ask-1", revision: 1 },
    { id: "ask-2", revision: 2 },
  ],
  roundNumber: 3,
  sourceTarget: { kind: "branch", branch: "feat/auth" },
  repoRoot: "/repo",
  workOrderPrompt: "Do the work",
  workOrderDigest: "0".repeat(64),
  gatePlan: { kind: "configured", command: "pnpm check" },
  revision: 10,
  rerunRequested: false,
  createdAt: 1_800_000_000_000,
  updatedAt: 1_800_000_005_000,
};

function completed(result: "changed" | "unchanged" = "changed"): RoundOperation {
  return {
    ...baseOperation,
    state: {
      phase: "completed",
      workspace: {
        kind: "detached-worktree",
        worktreePath: "/worktree",
        sourceTreeOid: "source-tree",
        sourceParentHead: "source-head",
        startedAt: 1,
        sourceHead: "source-head",
        preparedAt: 2,
      },
      worker: {
        executionId: "worker-1",
        startedAt: 2,
        outcome: "completed",
        completedAt: 3,
        diff: "diff --git a/a b/a",
        changedPaths: ["a"],
      },
      gate: {
        outcome: "passed",
        executionId: "gate-1",
        startedAt: 3,
        completedAt: 1_203,
        projectCount: 14,
        exitCode: 0,
      },
      commits: {
        executionId: "commit-1",
        baseHead: "before",
        startedAt: 4,
        committedAt: 5,
        count: 2,
        from: "before",
        to: "after",
      },
      landing: {
        effect: "source-landing",
        executionId: "landing-1",
        baselineCommit: "before",
        workerHead: "after",
        startedAt: 5,
        outcome: "applied",
        landedAt: 6,
      },
      recording: { executionId: "record-1", startedAt: 6, recordedAt: 7 },
      result:
        result === "changed"
          ? {
              kind: "changed",
              report: {
                executionId: "report-1",
                reportBoardId: "report-board",
                generation: "generation-2",
                boardIds: {
                  design: "design",
                  sequence: "sequence",
                  decisions: "decisions",
                  flagged: "flagged",
                  noise: "noise",
                  report: "report-board",
                },
                startedAt: 7,
                draftedAt: 8,
                verificationExecutionId: "verify-1",
                verificationStartedAt: 8,
                verifiedAt: 9,
              },
            }
          : { kind: "unchanged" },
      completedAt: 1_800_000_005_000,
    },
  } as RoundOperation;
}

describe("round transcript rows", () => {
  it("uses one stable dispatch row with the exact user turn", () => {
    expect(roundDispatchTranscriptRow(completed())).toEqual({
      kind: "turn",
      id: "round:dispatch-1:dispatch",
      speaker: "user",
      status: "complete",
      paragraphs: ["Dispatch it."],
      time: "2027-01-15T08:00:00.000Z",
    });
  });

  it("builds a factual return solely from durable receipts", () => {
    expect(roundReturnTranscriptRow(completed())).toMatchObject({
      id: "round:dispatch-1:return",
      speaker: "orchestrator",
      lead: "Round 3 is back",
      paragraphs: [
        "Round 3 is back — branch `feat/auth`, 2 asks, `pnpm check` passed across 14 projects in 1200 ms, 2 commits. The report was verified as generation `generation-2`.",
      ],
    });
  });

  it("states an unchanged return without inventing a report", () => {
    const row = roundReturnTranscriptRow(completed("unchanged"));
    if (row?.kind !== "turn") throw new Error("Expected a transcript turn.");
    expect(row.paragraphs[0]).toContain("no code changes, so no successor report was drafted");
  });

  it("does not fabricate a return for an active operation", () => {
    expect(
      roundReturnTranscriptRow({ ...completed(), state: { phase: "claimed" } } as RoundOperation),
    ).toBeUndefined();
  });
});
