// C07 chat-data reducer unit tests. The DOM tests drive the whole dock; these pin the
// pure fold's load-bearing branches so a regression reddens HERE, fast, with a clear cause.
import type { ReattachResult, ReviewAskStreamEvent } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import {
  detachedThreadRowsOf,
  foldAskStream,
  mergeTranscriptRows,
  reattachToRows,
} from "./chat-data";

const seen = () => new Map<string, number>();

const inFlightBase = (): ReattachResult => ({
  threads: [],
  inFlight: [
    { threadId: "t1", turnId: "u1", channel: "orchestrator", model: "", bodySoFar: "the answer" },
  ],
});

const complete: ReviewAskStreamEvent = {
  kind: "ask-complete",
  threadId: "t1",
  turnId: "u1",
  channel: "orchestrator",
  model: "opus",
  finalBody: "the answer",
  seq: 1,
};

// ── Codified positive control (task: the manual settle-branch control, made real) ─────
// The live-turn DOM test's presence-drops-after-settle assertion depends on `ask-complete`
// moving the turn OUT of `inFlight`. Neuter that branch (e.g. `case "ask-complete": return base`)
// and BOTH of the following reddens — the control now lives in the suite, not a hand-run note.
describe("foldAskStream ask-complete settle branch (codified positive control)", () => {
  it("removes the turn from inFlight so the presence affordance can drop", () => {
    const next = foldAskStream(inFlightBase(), complete, seen());
    expect(next.inFlight).toHaveLength(0);
  });

  it("lands the turn as a settled orchestrator message so the final prose stands", () => {
    const rows = reattachToRows(foldAskStream(inFlightBase(), complete, seen()));
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.kind).toBe("turn");
    if (row?.kind !== "turn") throw new Error("expected a turn");
    expect(row.speaker).toBe("orchestrator");
    expect(row.status).toBe("complete");
    expect(row.paragraphs.join(" ")).toContain("the answer");
  });
});

describe("ordered live harness state", () => {
  it("replaces a turn snapshot idempotently and keeps it through completion", () => {
    const state: ReviewAskStreamEvent = {
      kind: "ask-state",
      threadId: "t1",
      turnId: "u1",
      channel: "orchestrator",
      rows: [
        {
          kind: "turn",
          id: "u1::orchestrator",
          speaker: "orchestrator",
          status: "streaming",
          paragraphs: ["First", "Last"],
          blocks: [
            { kind: "text", text: "First" },
            {
              kind: "action",
              id: "tool-1",
              label: "app_ask_stage",
              status: "complete",
              toolKind: "mcp",
            },
            { kind: "text", text: "Last" },
          ],
        },
      ],
      seq: 2,
    };
    const live = foldAskStream(undefined, state, seen());
    const settled = foldAskStream(live, { ...complete, seq: 3 }, seen());
    const rows = reattachToRows(settled);
    const row = rows[0];
    if (row?.kind !== "turn") throw new Error("expected a turn");
    expect(row.id).toBe("u1::orchestrator");
    expect(row.blocks?.map((block) => block.kind)).toEqual(["text", "action", "text"]);
  });
});

describe("history and thread chronology", () => {
  it("dedupes by stable id, keeps the richer row, and orders by occurrence time", () => {
    const rich = {
      kind: "turn" as const,
      id: "u1::orchestrator",
      speaker: "orchestrator" as const,
      status: "complete" as const,
      time: "2026-08-29T10:00:01.000Z",
      paragraphs: ["answer"],
      blocks: [{ kind: "text" as const, text: "answer" }],
    };
    const simple = { ...rich, blocks: undefined };
    const user = {
      kind: "turn" as const,
      id: "u1::you",
      speaker: "user" as const,
      status: "complete" as const,
      time: "2026-08-29T10:00:00.000Z",
      paragraphs: ["question"],
    };
    const merged = mergeTranscriptRows([rich], [user, simple]);
    expect(merged.map((row) => (row.kind === "turn" ? row.id : row.kind))).toEqual([
      "u1::you",
      "u1::orchestrator",
    ]);
    const answer = merged[1];
    if (answer?.kind !== "turn") throw new Error("expected answer turn");
    expect(answer.blocks).toEqual(rich.blocks);
  });

  it("keeps timestamp-less markers stable without letting them break timed chronology", () => {
    const answer = {
      kind: "turn" as const,
      id: "u1::orchestrator",
      speaker: "orchestrator" as const,
      status: "complete" as const,
      time: "2026-08-29T10:00:01.000Z",
      paragraphs: ["answer"],
    };
    const boundary = {
      kind: "context-rebuilt" as const,
      id: "boundary-1",
      reason: "cursor vanished",
    };
    const question = {
      kind: "turn" as const,
      id: "u1::you",
      speaker: "user" as const,
      status: "complete" as const,
      time: "2026-08-29T10:00:00.000Z",
      paragraphs: ["question"],
    };

    expect(
      mergeTranscriptRows([answer, boundary], [question]).map((row) => {
        if (row.kind === "anchored-thread") return row.threadId;
        return row.kind === "detached-threads" ? row.kind : row.id;
      }),
    ).toEqual(["u1::you", "u1::orchestrator", "boundary-1"]);
  });
});

describe("detached quote-thread transcript projection", () => {
  it("projects only detached durable threads with their retained real target, idempotently", () => {
    const threads = {
      generic: { anchor: "generic", messages: [{ author: "user" as const, text: "hello" }] },
      attached: {
        anchor: "still present",
        lifecycle: "attached" as const,
        target: "current-prose",
        generation: "gen-2",
        messages: [{ author: "user" as const, text: "keep me anchored" }],
      },
      detached: {
        anchor: "removed",
        lifecycle: "detached" as const,
        target: "old-prose",
        generation: "gen-1",
        messages: [
          { author: "user" as const, text: "where did it go?" },
          { author: "orchestrator" as const, text: "the round replaced it" },
        ],
      },
    };

    const first = detachedThreadRowsOf(threads);
    const second = detachedThreadRowsOf(threads);

    expect(first).toEqual([
      {
        kind: "detached-threads",
        threads: [{ threadId: "detached", boardRef: "old-prose" }],
      },
    ]);
    expect(second).toEqual(first);
  });
});

describe("foldAskStream ask-delta seq guard", () => {
  it("rejects a replayed delta at a seq already applied (no double-append)", () => {
    const s = seen();
    const delta: ReviewAskStreamEvent = {
      kind: "ask-delta",
      threadId: "t1",
      turnId: "u1",
      channel: "orchestrator",
      delta: "once",
      seq: 5,
    };
    const first = foldAskStream(undefined, delta, s);
    const replayed = foldAskStream(first, delta, s);
    expect(replayed.inFlight[0]?.bodySoFar).toBe("once");
  });
});

describe("foldAskStream interrupted replay", () => {
  it("settles the channel-qualified durable message when no live row remains", () => {
    const base: ReattachResult = {
      threads: [
        {
          threadId: "t1",
          anchor: { kind: "fragment", label: "conversation", key: "t1" },
          messages: [
            {
              id: "u1::orchestrator",
              author: "harness",
              body: "partial",
              status: "streaming",
            },
          ],
        },
      ],
      inFlight: [],
    };
    const next = foldAskStream(
      base,
      {
        kind: "ask-interrupted",
        threadId: "t1",
        turnId: "u1",
        channel: "orchestrator",
        reason: "stopped",
      },
      seen(),
    );
    expect(next.threads[0]?.messages[0]?.status).toBe("interrupted");
  });
});
