import { describe, expect, it } from "vitest";
import {
  AskSchema,
  ClaimSchema,
  GenerationSchema,
  HarnessCursorSchema,
  RoundRecordSchema,
  SessionModelSchema,
  SessionThreadSchema,
  ThreadAnchorSchema,
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
  });

  it("parses a generation and rejects an unknown lens key", () => {
    const generation = {
      id: "gen-1",
      patchsetId: "ps-1",
      lensBoards: { design: "board-d", noise: "board-n" },
      compositionBoardId: "board-c",
      status: "frozen",
    };
    expect(GenerationSchema.parse(generation).lensBoards.design).toBe("board-d");
    expect(
      GenerationSchema.safeParse({ ...generation, lensBoards: { spec: "board-s" } }).success,
    ).toBe(false);
  });

  it("parses a round record with and without a minted generation", () => {
    const round = {
      asksDispatched: ["th-1"],
      workerCommitRange: { from: "abc123", to: "def456" },
      mintedPatchsetGeneration: "gen-2",
      boardGeneration: "gen-1",
      reportBoard: "board-r",
    };
    expect(RoundRecordSchema.parse(round).reportBoard).toBe("board-r");
    const unminted = { ...round, mintedPatchsetGeneration: undefined };
    expect(RoundRecordSchema.parse(unminted).mintedPatchsetGeneration).toBeUndefined();
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
});
