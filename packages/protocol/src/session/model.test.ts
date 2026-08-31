import { describe, expect, it } from "vitest";
import { sha256Hex } from "../sha256";
import {
  AskSchema,
  ClaimSchema,
  GenerationSchema,
  HarnessCursorSchema,
  isRoundOperationTerminal,
  LaneRowSchema,
  LensLaneSchema,
  RoundEventSchema,
  RoundOperationSchema,
  RoundRecordSchema,
  RoundReportDraftAttemptSchema,
  RoundReportDraftReceiptSchema,
  RoundReportReceiptSchema,
  RoundRunReceiptSchema,
  RoundSourceLandingAttemptSchema,
  RoundSourceLandingReceiptSchema,
  RoundWorkspaceAttemptSchema,
  RoundWorkspaceReceiptSchema,
  roundOperationProgressSnapshot,
  roundSourceLandingArtifactPaths,
  SessionModelSchema,
  SessionThreadSchema,
  SessionTranscriptRowSchema,
  ThreadAnchorSchema,
  TranscriptBlockSchema,
} from "./model";

const codeAnchor = {
  type: "code",
  ref: {
    patchsetId: "ps-1",
    path: "packages/core/src/pipeline.ts",
    side: "head",
    startLine: 10,
    endLine: 24,
    symbol: "decompose",
  },
} as const;

const quoteAnchor = {
  type: "quote",
  quote: { target: "el-7", quote: "the derivation is never hand-written", offsetHint: 2 },
} as const;

const thread = {
  threadId: "th-1",
  anchor: codeAnchor,
  ask: {
    intent: "Tighten the null check before the span read",
    exitLane: "round",
    provenance: "el-finding-3",
    lifecycle: "staged",
  },
} as const;

const operationPrompt = "Apply the requested change.";
const operationBase = {
  operationId: "op-1",
  sessionId: "session-1",
  reviewId: "review-1",
  dispatchId: "dispatch-1",
  sourcePatchsetId: "patchset-1",
  askOccurrences: [{ id: "ask-1", revision: 4 }],
  roundNumber: 1,
  sourceTarget: { kind: "branch", branch: "feat/round" },
  repoRoot: "/repo",
  workOrderPrompt: operationPrompt,
  workOrderDigest: sha256Hex(operationPrompt),
  gatePlan: { kind: "configured", command: "pnpm check" },
  revision: 0,
  rerunRequested: false,
  createdAt: 100,
  updatedAt: 100,
} as const;
const operationWorkspaceAttempt = {
  kind: "detached-worktree",
  worktreePath: "/worktrees/round-1",
  sourceTreeOid: "tree123",
  sourceParentHead: "abc123",
  startedAt: 105,
} as const;
const operationWorkspace = {
  ...operationWorkspaceAttempt,
  sourceHead: "abc123",
  preparedAt: 110,
} as const;
const operationWorker = {
  executionId: "worker-1",
  startedAt: 120,
  completedAt: 130,
  outcome: "completed",
  diff: "diff --git a/a b/a",
  changedPaths: ["a"],
} as const;
const operationGate = {
  executionId: "gate-1",
  startedAt: 140,
  completedAt: 150,
  outcome: "passed",
  exitCode: 0,
} as const;
const operationCommits = {
  executionId: "commit-1",
  baseHead: "abc123",
  startedAt: 155,
  from: "abc123",
  to: "def456",
  count: 1,
  committedAt: 160,
} as const;
const operationLandingAttempt = {
  effect: "source-landing",
  executionId: "landing-1",
  baselineCommit: operationCommits.from,
  workerHead: operationCommits.to,
  startedAt: 161,
} as const;
const operationLanding = {
  ...operationLandingAttempt,
  outcome: "applied",
  landedAt: 162,
} as const;
const operationRecording = {
  effect: "round-recording",
  executionId: "recording-1",
  startedAt: 163,
  recordedAt: 164,
} as const;
const operationBoardIds = {
  design: "design-1",
  sequence: "sequence-1",
  decisions: "decisions-1",
  flagged: "flagged-1",
  noise: "noise-1",
  report: "report-1",
} as const;

describe("session/ durable shapes (#466/#457)", () => {
  it("parses a harness cursor and rejects a negative turn count", () => {
    expect(
      HarnessCursorSchema.parse({
        harnessSessionId: "h-1",
        lastAssistantMessageAnchor: "msg-uuid-9",
        turnCount: 12,
      }).turnCount,
    ).toBe(12);
    expect(
      HarnessCursorSchema.safeParse({
        harnessSessionId: "h-1",
        lastAssistantMessageAnchor: "msg-uuid-9",
        turnCount: -1,
      }).success,
    ).toBe(false);
  });

  it("parses a claim with and without a PR (branch + PR are one claimed thing)", () => {
    expect(ClaimSchema.parse({ branch: "feat/x" })).toEqual({ branch: "feat/x" });
    expect(ClaimSchema.parse({ branch: "feat/x", prNumber: 496 }).prNumber).toBe(496);
  });

  it("parses both anchor arms and rejects an unknown arm", () => {
    expect(ThreadAnchorSchema.parse(codeAnchor).type).toBe("code");
    expect(ThreadAnchorSchema.parse(quoteAnchor).type).toBe("quote");
    expect(ThreadAnchorSchema.safeParse({ type: "board" }).success).toBe(false);
  });

  it("parses an ask and rejects an out-of-vocabulary lifecycle", () => {
    expect(AskSchema.parse(thread.ask).lifecycle).toBe("staged");
    expect(AskSchema.safeParse({ ...thread.ask, lifecycle: "done" }).success).toBe(false);
  });

  it("parses a thread reference (content lives in the transcript)", () => {
    expect(SessionThreadSchema.parse(thread).threadId).toBe("th-1");
    // A bare thread — no anchor, no ask — is a plain conversation thread.
    expect(SessionThreadSchema.parse({ threadId: "th-2" }).ask).toBeUndefined();
    // An anchored thread with no ask is the other plain shape.
    expect(SessionThreadSchema.parse({ threadId: "th-3", anchor: codeAnchor }).ask).toBeUndefined();
  });

  it("rejects an unanchored ask — the ask specialization requires an anchor", () => {
    const unanchored = { threadId: thread.threadId, ask: thread.ask };
    expect(SessionThreadSchema.safeParse(unanchored).success).toBe(false);
  });

  it("parses a generation and rejects an unknown lens key", () => {
    const generation = {
      id: "gen-1",
      patchsetId: "ps-1",
      lensBoards: { design: "board-d", noise: "board-n" },
      draftingBoardIds: { sequence: "board-next-sequence" },
      draftingReportBoardId: "board-next-report",
      absentLenses: { flagged: "no-findings" },
      failedLenses: { decisions: "The drafter response did not validate." },
      compositionBoardId: "board-c",
      status: "frozen",
    };
    expect(GenerationSchema.parse(generation).lensBoards.design).toBe("board-d");
    expect(GenerationSchema.parse(generation).draftingBoardIds?.sequence).toBe(
      "board-next-sequence",
    );
    expect(GenerationSchema.parse(generation).draftingReportBoardId).toBe("board-next-report");
    expect(GenerationSchema.parse(generation).absentLenses?.flagged).toBe("no-findings");
    expect(GenerationSchema.parse(generation).failedLenses?.decisions).toContain(
      "did not validate",
    );
    expect(
      GenerationSchema.safeParse({ ...generation, lensBoards: { spec: "board-s" } }).success,
    ).toBe(false);
    expect(
      GenerationSchema.safeParse({ ...generation, absentLenses: { design: "not-yet" } }).success,
    ).toBe(false);
    expect(
      GenerationSchema.safeParse({ ...generation, failedLenses: { design: "" } }).success,
    ).toBe(false);
  });

  it("parses a round record with and without a minted generation", () => {
    const round = {
      asksDispatched: ["th-1"],
      dispatchId: "dispatch-1",
      sourcePatchsetId: "ps-1",
      askOccurrences: [{ id: "th-1", revision: 7 }],
      regeneration: "pending",
      workerCommitRange: { from: "abc123", to: "def456" },
      mintedPatchsetGeneration: "gen-2",
      boardGeneration: "gen-1",
      reportBoard: "board-r",
      run: {
        startedAt: 1_777_777_777_000,
        sourceTarget: { kind: "branch", branch: "feat/receipts" },
        harness: { id: "codex", version: "0.146.0" },
        gate: {
          outcome: "passed",
          command: "pnpm check",
          durationMs: 12_500,
          projectCount: 7,
        },
      },
    };
    expect(RoundRecordSchema.parse(round).reportBoard).toBe("board-r");
    expect(RoundRecordSchema.parse(round).askOccurrences).toEqual([{ id: "th-1", revision: 7 }]);
    expect(RoundRecordSchema.parse(round).run).toEqual(round.run);
    const unminted = { ...round, mintedPatchsetGeneration: undefined };
    expect(RoundRecordSchema.parse(unminted).mintedPatchsetGeneration).toBeUndefined();
    const legacy = {
      asksDispatched: ["th-1"],
      workerCommitRange: { from: "abc123", to: "def456" },
      boardGeneration: "gen-1",
      reportBoard: "board-r",
    };
    expect(RoundRecordSchema.parse(legacy).dispatchId).toBeUndefined();
    expect(RoundRecordSchema.parse(legacy).run).toBeUndefined();
    expect(
      RoundRecordSchema.safeParse({ ...legacy, run: { startedAt: round.run.startedAt } }).success,
    ).toBe(false);
    expect(
      RoundRunReceiptSchema.safeParse({
        startedAt: 10,
        sourceTarget: { kind: "detached", head: "abc123" },
        harness: { id: "claude-code", version: "2.1.220" },
        gate: { outcome: "skipped", reason: "not-configured" },
      }).success,
    ).toBe(true);
    expect(
      RoundRecordSchema.safeParse({ ...round, askOccurrences: [{ id: "th-1", revision: -1 }] })
        .success,
    ).toBe(false);
  });

  it("accepts only an exact transactional source-landing receipt prefix", () => {
    const unitAId = "a".repeat(64);
    const unitBId = "b".repeat(64);
    const units = [
      {
        id: unitAId,
        path: "a.txt",
        baseline: {
          kind: "git",
          mode: "100644",
          oid: "a".repeat(40),
          rawSha256: "1".repeat(64),
        },
        target: {
          kind: "git",
          mode: "100644",
          oid: "b".repeat(40),
          rawSha256: "2".repeat(64),
        },
        ...roundSourceLandingArtifactPaths("landing-transaction", unitAId),
      },
      {
        id: unitBId,
        path: "b.txt",
        baseline: { kind: "absent" },
        target: {
          kind: "git",
          mode: "100644",
          oid: "c".repeat(40),
          rawSha256: "3".repeat(64),
        },
        ...roundSourceLandingArtifactPaths("landing-transaction", unitBId),
      },
    ] as const;
    const attempt = {
      effect: "source-landing",
      strategy: "exclusive-move-v1",
      executionId: "landing-transaction",
      baselineCommit: "baseline",
      workerHead: "worker",
      startedAt: 1,
      units,
      unitReceipts: [{ unitId: unitAId, outcome: "applied", landedAt: 2 }],
    } as const;

    expect(RoundSourceLandingAttemptSchema.parse(attempt)).toEqual(attempt);
    expect(
      RoundSourceLandingAttemptSchema.safeParse({
        ...attempt,
        unitReceipts: [{ unitId: unitBId, outcome: "applied", landedAt: 2 }],
      }).success,
    ).toBe(false);
    expect(
      RoundSourceLandingAttemptSchema.safeParse({
        ...attempt,
        units: [{ ...units[0], stagePath: units[0].backupPath }, units[1]],
      }).success,
    ).toBe(false);
    expect(
      RoundSourceLandingAttemptSchema.safeParse({
        ...attempt,
        unitReceipts: [{ ...attempt.unitReceipts[0], unitId: "a/backup/x" }],
        units: [
          {
            ...units[0],
            id: "a/backup/x",
            ...roundSourceLandingArtifactPaths("landing-transaction", "a/backup/x"),
          },
          units[1],
        ],
      }).success,
    ).toBe(false);
    expect(
      RoundSourceLandingAttemptSchema.safeParse({
        ...attempt,
        units: [{ ...units[0], path: ".rennet/round-landings/live.txt" }, units[1]],
      }).success,
    ).toBe(false);
    for (const path of [".RENNET/round-landings/live.txt", ".ReNnEt/round-landings/live.txt"]) {
      expect(
        RoundSourceLandingAttemptSchema.safeParse({
          ...attempt,
          units: [{ ...units[0], path }, units[1]],
        }).success,
      ).toBe(false);
    }
    expect(
      RoundSourceLandingAttemptSchema.safeParse({
        ...attempt,
        units: [{ ...units[0], path: "nested/.rennet/live.txt" }, units[1]],
      }).success,
    ).toBe(true);
    expect(
      RoundSourceLandingAttemptSchema.safeParse({
        ...attempt,
        units: [
          {
            ...units[0],
            baseline: { kind: "git", mode: "100644", oid: "a".repeat(40) },
          },
          units[1],
        ],
      }).success,
    ).toBe(false);
    expect(
      RoundSourceLandingAttemptSchema.safeParse({
        ...attempt,
        units: [
          {
            ...units[0],
            baseline: { kind: "git", mode: "160000", oid: "a".repeat(40) },
          },
          units[1],
        ],
      }).success,
    ).toBe(false);
    expect(
      RoundSourceLandingReceiptSchema.safeParse({
        ...attempt,
        outcome: "applied",
        landedAt: 3,
      }).success,
    ).toBe(false);
    expect(
      RoundSourceLandingReceiptSchema.parse({
        ...attempt,
        unitReceipts: [
          ...attempt.unitReceipts,
          { unitId: unitBId, outcome: "already-applied", landedAt: 3 },
        ],
        outcome: "applied",
        landedAt: 4,
      }).outcome,
    ).toBe("applied");
  });

  it("binds branch-ref landing to the selected branch head", () => {
    const selectedHead = "a".repeat(40);
    const workerHead = "b".repeat(40);
    const attempt = {
      effect: "source-landing",
      strategy: "branch-ref-v1",
      executionId: "landing-selected-branch",
      branch: "feat/round",
      expectedHead: selectedHead,
      baselineCommit: selectedHead,
      workerHead,
      startedAt: 1,
    } as const;

    expect(RoundSourceLandingAttemptSchema.parse(attempt)).toEqual(attempt);
    expect(
      RoundSourceLandingAttemptSchema.safeParse({
        ...attempt,
        baselineCommit: "c".repeat(40),
      }).success,
    ).toBe(false);
    expect(
      RoundSourceLandingReceiptSchema.parse({
        ...attempt,
        outcome: "already-applied",
        landedAt: 2,
      }),
    ).toMatchObject({
      strategy: "branch-ref-v1",
      branch: "feat/round",
      expectedHead: selectedHead,
      outcome: "already-applied",
    });

    const operation = {
      ...operationBase,
      state: {
        phase: "source-landing",
        workspace: {
          ...operationWorkspace,
          sourceParentHead: selectedHead,
          sourceHead: selectedHead,
        },
        worker: operationWorker,
        gate: operationGate,
        commits: {
          ...operationCommits,
          baseHead: selectedHead,
          from: selectedHead,
          to: workerHead,
        },
        landing: attempt,
      },
    } as const;
    expect(RoundOperationSchema.safeParse(operation).success).toBe(true);
    expect(
      RoundOperationSchema.safeParse({
        ...operation,
        sourceTarget: { kind: "branch", branch: "feat/other" },
      }).success,
    ).toBe(false);
  });

  // ── The rework count (review finding 10) ──────────────────────────────────
  it("carries the report-derived rework count, and honestly none when no report drafted", () => {
    const round = {
      asksDispatched: ["th-1", "th-2", "th-3"],
      workerCommitRange: { from: "abc123", to: "def456" },
      boardGeneration: "gen-1",
      reportBoard: "board-r",
      reworkCount: 0,
    };
    // A round can dispatch three asks and rework NOTHING — the two numbers are unrelated,
    // which is exactly why the count is its own field rather than `asksDispatched.length`.
    expect(RoundRecordSchema.parse(round).reworkCount).toBe(0);
    expect(
      RoundRecordSchema.parse({ ...round, reworkCount: undefined }).reworkCount,
    ).toBeUndefined();
    expect(RoundRecordSchema.safeParse({ ...round, reworkCount: -1 }).success).toBe(false);
  });

  // ── The lane unions (review finding 8) ────────────────────────────────────
  //
  // The verdict is bound to the state that can HAVE one. These are the states the old
  // bag-of-optionals row admitted and this union refuses: a settled lens lane with no
  // verdict, a failed lane with no reason, and an unstarted lane already carrying a verdict.
  it("makes an unverdicted settled lens lane unrepresentable", () => {
    const base = { id: "design", label: "Design" };
    expect(LensLaneSchema.safeParse({ ...base, status: "done" }).success).toBe(false);
    expect(
      LensLaneSchema.safeParse({ ...base, status: "done", verdict: "carrying-forward" }).success,
    ).toBe(true);
    expect(LensLaneSchema.safeParse({ ...base, status: "failed" }).success).toBe(false);
    expect(
      LensLaneSchema.safeParse({ ...base, status: "failed", reason: "no board" }).success,
    ).toBe(true);
    expect(LensLaneSchema.safeParse({ ...base, status: "absent" }).success).toBe(false);
    expect(
      LensLaneSchema.safeParse({ ...base, status: "absent", reason: "no spec artifacts" }).success,
    ).toBe(true);
    // An in-flight lane has nothing to report yet, so it parses with nothing to report.
    expect(LensLaneSchema.safeParse({ ...base, status: "queued" }).success).toBe(true);
    // A step row is a DIFFERENT shape: it settles with its own account and never reaches
    // `drafted`, which belongs only to a lens waiting on its verdict.
    expect(LaneRowSchema.safeParse({ id: "turn", label: "Ran it", status: "done" }).success).toBe(
      true,
    );
    expect(LaneRowSchema.safeParse({ id: "turn", label: "Ran it", status: "failed" }).success).toBe(
      false,
    );
    expect(
      LaneRowSchema.safeParse({ id: "turn", label: "Ran it", status: "drafted" }).success,
    ).toBe(false);
    expect(LaneRowSchema.safeParse({ id: "turn", label: "Ran it", status: "absent" }).success).toBe(
      false,
    );
  });

  // ── The event sequence (review finding 7) ─────────────────────────────────
  it("carries an optional monotonic seq — present from this daemon, absent from an older one", () => {
    expect(RoundEventSchema.parse({ type: "dispatched", seq: 4 }).seq).toBe(4);
    expect(RoundEventSchema.parse({ type: "dispatched" }).seq).toBeUndefined();
    expect(RoundEventSchema.safeParse({ type: "dispatched", seq: -1 }).success).toBe(false);
    expect(RoundEventSchema.parse({ type: "unchanged" })).toEqual({ type: "unchanged" });
  });

  it("makes a durable round operation's active and terminal phases explicit", () => {
    const claimed = RoundOperationSchema.parse({
      ...operationBase,
      state: { phase: "claimed" },
    });
    expect(isRoundOperationTerminal(claimed)).toBe(false);
    expect(
      RoundOperationSchema.parse({
        ...operationBase,
        revision: 1,
        updatedAt: 105,
        state: { phase: "workspace-preparing", workspace: operationWorkspaceAttempt },
      }).state.phase,
    ).toBe("workspace-preparing");
    const completed = RoundOperationSchema.parse({
      ...operationBase,
      revision: 8,
      updatedAt: 180,
      state: {
        phase: "completed",
        workspace: operationWorkspace,
        worker: operationWorker,
        gate: operationGate,
        commits: operationCommits,
        landing: operationLanding,
        recording: operationRecording,
        result: {
          kind: "changed",
          report: {
            executionId: "report-draft-1",
            reportBoardId: "report-1",
            generation: "gen-2",
            boardIds: operationBoardIds,
            startedAt: 165,
            draftedAt: 170,
            verificationExecutionId: "report-verify-1",
            verificationStartedAt: 175,
            verifiedAt: 180,
          },
        },
        completedAt: 180,
      },
    });
    expect(isRoundOperationTerminal(completed)).toBe(true);
    expect(
      RoundOperationSchema.safeParse({
        ...operationBase,
        state: {
          phase: "completed",
          workspace: operationWorkspace,
          worker: operationWorker,
          gate: operationGate,
          commits: operationCommits,
          landing: operationLanding,
          recording: operationRecording,
          result: { kind: "changed" },
          completedAt: 180,
        },
      }).success,
    ).toBe(false);
    expect(
      RoundOperationSchema.safeParse({
        ...operationBase,
        state: {
          phase: "completed",
          workspace: operationWorkspace,
          worker: { ...operationWorker, diff: "", changedPaths: [] },
          gate: operationGate,
          commits: { ...operationCommits, count: 0, from: "abc123", to: "abc123" },
          landing: {
            ...operationLandingAttempt,
            baselineCommit: "abc123",
            workerHead: "abc123",
            outcome: "unchanged",
            landedAt: 162,
          },
          recording: operationRecording,
          result: {
            kind: "changed",
            report: {
              executionId: "report-draft-1",
              reportBoardId: "report-1",
              generation: "gen-2",
              boardIds: operationBoardIds,
              startedAt: 165,
              draftedAt: 170,
              verificationExecutionId: "report-verify-1",
              verificationStartedAt: 175,
              verifiedAt: 180,
            },
          },
          completedAt: 180,
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    [
      "draft attempt",
      RoundReportDraftAttemptSchema,
      {
        executionId: "report-draft-1",
        reportBoardId: "different-report",
        generation: "gen-2",
        boardIds: operationBoardIds,
        startedAt: 165,
      },
    ],
    [
      "draft receipt",
      RoundReportDraftReceiptSchema,
      {
        executionId: "report-draft-1",
        reportBoardId: "different-report",
        generation: "gen-2",
        boardIds: operationBoardIds,
        startedAt: 165,
        draftedAt: 170,
      },
    ],
    [
      "verified receipt",
      RoundReportReceiptSchema,
      {
        executionId: "report-draft-1",
        reportBoardId: "different-report",
        generation: "gen-2",
        boardIds: operationBoardIds,
        startedAt: 165,
        draftedAt: 170,
        verificationExecutionId: "report-verify-1",
        verificationStartedAt: 175,
        verifiedAt: 180,
      },
    ],
  ])("requires reportBoardId to equal boardIds.report in a %s", (_kind, schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it("persists the reviewed tree before preparing a detached dirty snapshot", () => {
    const attempt = RoundWorkspaceAttemptSchema.parse(operationWorkspaceAttempt);
    expect(attempt).toEqual({
      kind: "detached-worktree",
      worktreePath: "/worktrees/round-1",
      sourceTreeOid: "tree123",
      sourceParentHead: "abc123",
      startedAt: 105,
    });
    expect("sourceHead" in attempt).toBe(false);

    const receipt = RoundWorkspaceReceiptSchema.parse({
      ...attempt,
      sourceHead: "synthetic-dirty-tree-commit",
      preparedAt: 110,
    });
    expect(receipt.sourceHead).not.toBe(receipt.sourceParentHead);
    expect(
      RoundOperationSchema.parse({
        ...operationBase,
        sourceTarget: { kind: "detached", head: "abc123" },
        state: { phase: "prepared", workspace: receipt },
      }).state.phase,
    ).toBe("prepared");
    expect(
      RoundOperationSchema.safeParse({
        ...operationBase,
        sourceTarget: { kind: "detached", head: "different-parent" },
        state: { phase: "workspace-preparing", workspace: attempt },
      }).success,
    ).toBe(false);
  });

  it("projects a durable operation to a UI-safe receipt snapshot", () => {
    const operation = RoundOperationSchema.parse({
      ...operationBase,
      revision: 8,
      updatedAt: 180,
      state: {
        phase: "completed",
        workspace: operationWorkspace,
        worker: operationWorker,
        gate: { ...operationGate, projectCount: 14 },
        commits: { ...operationCommits, count: 2 },
        landing: operationLanding,
        recording: operationRecording,
        result: {
          kind: "changed",
          report: {
            executionId: "report-draft-1",
            reportBoardId: "report-1",
            generation: "gen-2",
            boardIds: operationBoardIds,
            startedAt: 165,
            draftedAt: 170,
            verificationExecutionId: "report-verify-1",
            verificationStartedAt: 175,
            verifiedAt: 180,
          },
        },
        completedAt: 180,
      },
    });
    const snapshot = roundOperationProgressSnapshot(operation);

    expect(RoundEventSchema.parse({ type: "operation", snapshot, seq: 0 })).toMatchObject({
      type: "operation",
      snapshot: {
        operationId: "op-1",
        revision: 8,
        rerunRequested: false,
        draining: true,
        createdAt: 100,
        roundNumber: 1,
        sourceTarget: { kind: "branch", branch: "feat/round" },
        askCount: 1,
        gatePlan: { kind: "configured", command: "pnpm check" },
        state: {
          phase: "completed",
          worker: { status: "done", fileCount: 1 },
          gate: { status: "passed", durationMs: 10, projectCount: 14 },
          commits: { status: "done", count: 2 },
          result: {
            kind: "changed",
            report: {
              status: "verified",
              reportBoardId: "report-1",
              generation: "gen-2",
            },
          },
        },
      },
    });
    const encoded = JSON.stringify(snapshot);
    for (const privateValue of [
      "/repo",
      "/worktrees/round-1",
      operationPrompt,
      "diff --git a/a b/a",
      "worker-1",
      "gate-1",
      "commit-1",
      "abc123",
      "def456",
    ]) {
      expect(encoded).not.toContain(privateValue);
    }
  });

  it("does not expose completed work as returned until its durable return receipt exists", () => {
    const completed = RoundOperationSchema.parse({
      ...operationBase,
      revision: 8,
      updatedAt: 180,
      state: {
        phase: "completed",
        workspace: operationWorkspace,
        worker: operationWorker,
        gate: operationGate,
        commits: operationCommits,
        landing: operationLanding,
        recording: operationRecording,
        result: {
          kind: "changed",
          report: {
            executionId: "report-draft-1",
            reportBoardId: "report-1",
            generation: "gen-2",
            boardIds: operationBoardIds,
            startedAt: 165,
            draftedAt: 170,
            verificationExecutionId: "report-verify-1",
            verificationStartedAt: 175,
            verifiedAt: 180,
          },
        },
        completedAt: 180,
      },
    });

    expect(roundOperationProgressSnapshot(completed)).toMatchObject({
      rerunRequested: false,
      draining: true,
    });
    expect(
      roundOperationProgressSnapshot(
        RoundOperationSchema.parse({ ...completed, revision: 9, rerunRequested: true }),
      ),
    ).toMatchObject({ rerunRequested: true, draining: true });

    const returned = RoundOperationSchema.parse({
      ...completed,
      revision: 9,
      updatedAt: 190,
      state: { ...completed.state, returnedAt: 190 },
    });
    expect(roundOperationProgressSnapshot(returned)).toMatchObject({
      rerunRequested: false,
      draining: false,
    });
    expect(
      RoundOperationSchema.safeParse({
        ...completed,
        state: { ...completed.state, returnedAt: 179 },
      }).success,
    ).toBe(false);
  });

  it("coarsens landing and recording without advancing visible commit progress early", () => {
    const landing = RoundOperationSchema.parse({
      ...operationBase,
      state: {
        phase: "source-landing",
        workspace: operationWorkspace,
        worker: operationWorker,
        gate: operationGate,
        commits: operationCommits,
        landing: operationLandingAttempt,
      },
    });
    expect(roundOperationProgressSnapshot(landing).state).toMatchObject({
      phase: "committing",
      commits: { status: "running" },
    });

    const recorded = RoundOperationSchema.parse({
      ...operationBase,
      state: {
        phase: "round-recorded",
        workspace: operationWorkspace,
        worker: operationWorker,
        gate: operationGate,
        commits: operationCommits,
        landing: operationLanding,
        recording: operationRecording,
      },
    });
    expect(roundOperationProgressSnapshot(recorded).state).toMatchObject({
      phase: "commits-settled",
      commits: { status: "done", count: 1 },
    });
  });

  it("rejects failed prerequisites and contradictory unchanged evidence", () => {
    const failedWorker = {
      ...operationWorker,
      outcome: "failed",
      termination: { kind: "error", reason: "worker stopped" },
    } as const;
    const failedGate = {
      ...operationGate,
      outcome: "failed",
      termination: { kind: "exit", exitCode: 1 },
    } as const;
    for (const [worker, gate] of [
      [failedWorker, operationGate],
      [operationWorker, failedGate],
    ] as const) {
      expect(
        RoundOperationSchema.safeParse({
          ...operationBase,
          state: {
            phase: "completed",
            workspace: operationWorkspace,
            worker,
            gate,
            commits: operationCommits,
            landing: operationLanding,
            recording: operationRecording,
            result: {
              kind: "changed",
              report: {
                executionId: "report-draft-1",
                reportBoardId: "report-1",
                generation: "gen-2",
                boardIds: operationBoardIds,
                startedAt: 165,
                draftedAt: 170,
                verificationExecutionId: "report-verify-1",
                verificationStartedAt: 175,
                verifiedAt: 180,
              },
            },
            completedAt: 180,
          },
        }).success,
      ).toBe(false);
    }
    const contradictoryCommits = {
      ...operationCommits,
      count: 0,
      from: "abc123",
      to: "abc123",
    } as const;
    expect(
      RoundOperationSchema.safeParse({
        ...operationBase,
        state: {
          phase: "failed",
          failure: { at: "gate", reason: "gate stopped", failedAt: 150 },
        },
      }).success,
    ).toBe(false);
    expect(
      RoundOperationSchema.safeParse({
        ...operationBase,
        state: {
          phase: "completed",
          workspace: operationWorkspace,
          worker: operationWorker,
          gate: operationGate,
          commits: contradictoryCommits,
          landing: {
            ...operationLandingAttempt,
            baselineCommit: contradictoryCommits.from,
            workerHead: contradictoryCommits.to,
            outcome: "unchanged",
            landedAt: 162,
          },
          recording: operationRecording,
          result: { kind: "unchanged" },
          completedAt: 180,
        },
      }).success,
    ).toBe(false);
  });

  it("binds the operation identity and admits an honest detached source", () => {
    expect(
      RoundOperationSchema.safeParse({
        ...operationBase,
        workOrderDigest: "a".repeat(64),
        state: { phase: "claimed" },
      }).success,
    ).toBe(false);
    expect(
      RoundOperationSchema.safeParse({
        ...operationBase,
        askOccurrences: [operationBase.askOccurrences[0], operationBase.askOccurrences[0]],
        state: { phase: "claimed" },
      }).success,
    ).toBe(false);
    expect(
      RoundOperationSchema.parse({
        ...operationBase,
        sourceTarget: { kind: "detached", head: "abc123" },
        state: { phase: "claimed" },
      }).sourceTarget.kind,
    ).toBe("detached");
  });

  it("records an absent gate honestly and writes report identity before drafting", () => {
    const skippedGate = { outcome: "skipped", reason: "not-configured", settledAt: 150 } as const;
    const noCommits = {
      ...operationCommits,
      to: operationCommits.from,
      count: 0,
    } as const;
    const unchangedLanding = {
      ...operationLanding,
      workerHead: noCommits.to,
      outcome: "unchanged",
    } as const;
    expect(
      RoundOperationSchema.parse({
        ...operationBase,
        gatePlan: { kind: "absent" },
        state: {
          phase: "completed",
          workspace: operationWorkspace,
          worker: { ...operationWorker, diff: "", changedPaths: [] },
          gate: skippedGate,
          commits: noCommits,
          landing: unchangedLanding,
          recording: operationRecording,
          result: { kind: "unchanged" },
          completedAt: 180,
        },
      }).state.phase,
    ).toBe("completed");
    expect(
      RoundOperationSchema.safeParse({
        ...operationBase,
        state: {
          phase: "gate-settled",
          workspace: operationWorkspace,
          worker: operationWorker,
          gate: skippedGate,
        },
      }).success,
    ).toBe(false);
    expect(
      RoundOperationSchema.safeParse({
        ...operationBase,
        state: {
          phase: "report-drafting",
          workspace: operationWorkspace,
          worker: operationWorker,
          gate: operationGate,
          commits: operationCommits,
          landing: operationLanding,
          recording: operationRecording,
        },
      }).success,
    ).toBe(false);
    expect(
      RoundOperationSchema.parse({
        ...operationBase,
        state: {
          phase: "report-drafting",
          workspace: operationWorkspace,
          worker: operationWorker,
          gate: operationGate,
          commits: operationCommits,
          landing: operationLanding,
          recording: operationRecording,
          report: {
            executionId: "report-draft-1",
            reportBoardId: "report-1",
            generation: "gen-2",
            boardIds: operationBoardIds,
            startedAt: 165,
          },
        },
      }).state.phase,
    ).toBe("report-drafting");
  });

  it("carries a frozen-predecessor id for a landed round, none for a first-generation round", () => {
    const landed = {
      asksDispatched: ["th-1"],
      workerCommitRange: { from: "abc123", to: "def456" },
      mintedPatchsetGeneration: "gen-2",
      boardGeneration: "gen-2",
      reportBoard: "board-r",
      frozenPredecessor: "gen-1",
    };
    // The earlier generation the switcher drills back to — distinct from the minted id (F3).
    expect(RoundRecordSchema.parse(landed).frozenPredecessor).toBe("gen-1");
    const firstGen = { ...landed, frozenPredecessor: undefined };
    expect(RoundRecordSchema.parse(firstGen).frozenPredecessor).toBeUndefined();
  });

  it("parses the durable root: claimed with a review, and a bare no-target chat", () => {
    const session = {
      id: "s-1",
      projectId: "p-1",
      claim: { branch: "feat/x", prNumber: 12 },
      reviewId: "r-1",
      harnessCursor: { harnessSessionId: "h-1", lastAssistantMessageAnchor: "m-1", turnCount: 3 },
      threads: [thread],
      createdAt: 1_756_252_800_000,
    };
    expect(SessionModelSchema.parse(session).claim?.prNumber).toBe(12);
    // The no-target chat: a session without claim or review, upgradeable in place.
    const bare = { id: "s-2", projectId: "p-1", threads: [], createdAt: 1 };
    const parsed = SessionModelSchema.parse(bare);
    expect(parsed.claim).toBeUndefined();
    expect(parsed.reviewId).toBeUndefined();
  });

  it("keeps old persisted transcript turns readable without ordered blocks", () => {
    const oldTurn = {
      kind: "turn",
      id: "turn-old",
      speaker: "orchestrator",
      status: "complete",
      paragraphs: ["Finished the change."],
      preface: [
        {
          kind: "action",
          id: "action-old",
          label: "Read",
          status: "complete",
          toolKind: "read",
        },
      ],
      body: [{ kind: "text", text: "Finished the change." }],
    } as const;

    expect(SessionTranscriptRowSchema.parse(oldTurn)).toEqual(oldTurn);
  });

  it("parses one ordered transcript block stream across activity and content", () => {
    const blocks = [
      {
        kind: "thought",
        id: "thought-1",
        status: "complete",
        seconds: 1.25,
        text: ["Check the caller first."],
      },
      { kind: "text", text: "The caller passes a stable id." },
      {
        kind: "action",
        id: "action-1",
        label: "Read",
        status: "complete",
        toolKind: "read",
      },
      {
        kind: "code",
        path: "packages/core/src/example.ts",
        lang: "ts",
        code: "export const answer = 42;",
      },
    ] as const;

    expect(blocks.map((block) => TranscriptBlockSchema.parse(block).kind)).toEqual([
      "thought",
      "text",
      "action",
      "code",
    ]);
    expect(
      SessionTranscriptRowSchema.parse({
        kind: "turn",
        id: "turn-new",
        speaker: "orchestrator",
        status: "complete",
        paragraphs: ["The caller passes a stable id."],
        blocks,
      }),
    ).toMatchObject({ blocks });
  });

  it("keeps transcript timestamps additive on turns and compact boundaries", () => {
    const time = "2026-08-29T10:30:00.000Z";
    const turn = SessionTranscriptRowSchema.parse({
      kind: "turn",
      id: "turn-timed",
      speaker: "orchestrator",
      status: "complete",
      paragraphs: [],
      time,
    });
    if (turn.kind !== "turn") throw new Error("expected a turn row");
    expect(turn.time).toBe(time);

    const compact = SessionTranscriptRowSchema.parse({
      kind: "compact-boundary",
      id: "compact-timed",
      time,
    });
    if (compact.kind !== "compact-boundary") throw new Error("expected a compact boundary");
    expect(compact.time).toBe(time);

    const oldCompact = SessionTranscriptRowSchema.parse({
      kind: "compact-boundary",
      id: "compact-old",
    });
    if (oldCompact.kind !== "compact-boundary") throw new Error("expected a compact boundary");
    expect(oldCompact.time).toBeUndefined();
  });
});
