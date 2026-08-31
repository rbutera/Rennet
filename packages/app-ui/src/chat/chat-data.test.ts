// C07 chat-data reducer unit tests. The DOM tests drive the whole dock; these pin the
// pure fold's load-bearing branches so a regression reddens HERE, fast, with a clear cause.
import type { ReattachResult, ReviewAskStreamEvent } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import type { TranscriptRow } from "./chat-data";
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

// ── Per-delta derivation cost (perf audit §3 H2) ─────────────────────────────────────
// `reattachToRows` used to re-walk every thread, every message and every paragraph split on
// EVERY streamed token, because `foldAskStream` mints a fresh `ReattachResult` per delta.
// The derivation is now memoized on the thread / in-flight-turn objects the fold preserves.
//
// The seam is the fixture, not the production code: a settled thread exposes `messages`
// through a counting getter, which is the exact property the per-thread derivation reads, so
// the count IS the number of derivations. Positive control: drop the `threadRows` WeakMap
// lookup in `threadToRows` and the counts go 1 → 3 (once per derivation) and the identity
// assertion below reddens too.

type CountingThread = ReattachResult["threads"][number];

function countingThread(
  threadId: string,
  counts: Map<string, number>,
  messageCount = 3,
): CountingThread {
  const messages = Array.from({ length: messageCount }, (_, index) => ({
    id: `${threadId}-m${index}`,
    author: (index % 2 === 0 ? "you" : "harness") as "you" | "harness",
    body: `paragraph one\n\nparagraph two of ${threadId} message ${index}`,
    status: "complete" as const,
    time: `2026-08-29T10:0${index}:00.000Z`,
  }));
  return {
    threadId,
    anchor: { kind: "fragment" as const, label: "conversation", key: threadId },
    get messages() {
      counts.set(threadId, (counts.get(threadId) ?? 0) + 1);
      return messages;
    },
  };
}

const rowIds = (rows: readonly TranscriptRow[]) =>
  rows.map((row) => (row.kind === "turn" ? row.id : row.kind));

const askDelta = (turnId: string, delta: string, seq: number): ReviewAskStreamEvent => ({
  kind: "ask-delta",
  threadId: "live",
  turnId,
  channel: "orchestrator",
  delta,
  seq,
});

describe("transcript derivation cost per streamed delta", () => {
  it("derives each settled thread once across two deltas, re-deriving only the live turn", () => {
    const counts = new Map<string, number>();
    const settled = Array.from({ length: 6 }, (_, index) => countingThread(`t${index}`, counts));
    const s = seen();

    let state: ReattachResult = { threads: settled, inFlight: [] };
    const first = reattachToRows(state);
    state = foldAskStream(state, askDelta("live-1", "hello", 1), s);
    const second = reattachToRows(state);
    state = foldAskStream(state, askDelta("live-1", " there", 2), s);
    const third = reattachToRows(state);

    // Six settled threads, three derivations of the transcript: each thread derived ONCE.
    expect([...counts.values()]).toEqual([1, 1, 1, 1, 1, 1]);
    expect(counts.size).toBe(6);

    // Same row objects, not merely equal ones — a re-derivation would allocate fresh rows.
    const settledRowCount = first.length;
    for (let index = 0; index < settledRowCount; index++) {
      expect(second[index]).toBe(first[index]);
      expect(third[index]).toBe(first[index]);
    }

    // The live turn, and only the live turn, is new text on each delta.
    const live = third[third.length - 1];
    if (live?.kind !== "turn") throw new Error("expected the live turn last");
    expect(live.status).toBe("streaming");
    expect(live.paragraphs.join(" ")).toBe("hello there");
    expect(second).toHaveLength(settledRowCount + 1);
    expect(third).toHaveLength(settledRowCount + 1);
  });

  it("derives the same rows after K deltas as a from-scratch derivation of the same state", async () => {
    const counts = new Map<string, number>();
    const s = seen();
    let state: ReattachResult = {
      threads: [countingThread("t0", counts), countingThread("t1", counts, 2)],
      inFlight: [
        // A live turn on a thread the snapshot already knows, so the interleaving (thread
        // rows, then that thread's live turns) is exercised, not just the orphan tail.
        { threadId: "t0", turnId: "resident", channel: "orchestrator", model: "", bodySoFar: "" },
      ],
    };
    state = foldAskStream(state, askDelta("orphan", "a brand new ask", 1), s);
    for (let index = 0; index < 8; index++) {
      state = foldAskStream(state, askDelta("orphan", ` chunk-${index}`, index + 2), s);
    }

    // Indexing the live turns by thread replaced a nested `threads × inFlight` scan. Equivalence
    // against a cold derivation cannot see an ordering regression (both sides run the same
    // code), so the interleaving is pinned literally: a thread's rows, then THAT thread's live
    // turns, then the live turns whose thread the snapshot never carried.
    expect(rowIds(reattachToRows(state))).toEqual([
      "t0-m0",
      "t0-m1",
      "t0-m2",
      "resident::orchestrator",
      "t1-m0",
      "t1-m1",
      "orphan::orchestrator",
    ]);

    state = foldAskStream(
      state,
      { ...complete, threadId: "t1", turnId: "resident", finalBody: "settled reply" },
      s,
    );

    const memoized = reattachToRows(state);
    // The reference derivation runs in a FRESHLY EVALUATED copy of the module, so its caches
    // are empty whatever they are keyed on. Cloning the state instead was not enough: a memo
    // keyed on `threadId` (a string a clone reproduces) poisoned the reference too, and this
    // assertion passed while serving stale rows — the reference has to be cold by
    // construction, not by hoping the key misses.
    vi.resetModules();
    const cold = await import("./chat-data");
    const fromScratch = cold.reattachToRows(state);

    expect(memoized).toEqual(fromScratch);
    expect(rowIds(memoized)).toEqual([
      "t0-m0",
      "t0-m1",
      "t0-m2",
      "t1-m0",
      "t1-m1",
      "resident::orchestrator",
      "orphan::orchestrator",
    ]);
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
