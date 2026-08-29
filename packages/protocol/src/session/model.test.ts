import { describe, expect, it } from "vitest";
import {
  AskSchema,
  ClaimSchema,
  GenerationSchema,
  HarnessCursorSchema,
  LaneRowSchema,
  LensLaneSchema,
  RoundEventSchema,
  RoundRecordSchema,
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
      absentLenses: { flagged: "no-material" },
      compositionBoardId: "board-c",
      status: "frozen",
    };
    expect(GenerationSchema.parse(generation).lensBoards.design).toBe("board-d");
    expect(GenerationSchema.parse(generation).absentLenses?.flagged).toBe("no-material");
    expect(
      GenerationSchema.safeParse({ ...generation, lensBoards: { spec: "board-s" } }).success,
    ).toBe(false);
    expect(
      GenerationSchema.safeParse({ ...generation, absentLenses: { design: "not-yet" } }).success,
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
