import type { ReattachResult, ReviewAskStreamEvent } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import {
  emptyTimeline,
  foldStreamEvent,
  isTurnRunning,
  reattach,
  type TimelineState,
} from "./turn-timeline";

const delta = (turnId: string, d: string): ReviewAskStreamEvent => ({
  kind: "ask-delta",
  threadId: "th1",
  turnId,
  channel: "orchestrator",
  delta: d,
});
const complete = (turnId: string, body: string): ReviewAskStreamEvent => ({
  kind: "ask-complete",
  threadId: "th1",
  turnId,
  channel: "orchestrator",
  model: "claude",
  finalBody: body,
});

function fold(state: TimelineState, events: ReviewAskStreamEvent[]): TimelineState {
  return events.reduce(foldStreamEvent, state);
}

describe("turn-timeline reattach (#382 M2, task 1.1)", () => {
  it("paints persisted thread messages in order", () => {
    const result: ReattachResult = {
      threads: [
        {
          threadId: "th1",
          anchor: { kind: "line", label: "evict.ts:41", key: "k" },
          messages: [
            { id: "t1::you", author: "you", body: "which fix?" },
            {
              id: "t1::orchestrator",
              author: "harness",
              model: "claude",
              body: "the lock-scope one",
            },
          ],
        },
      ],
      inFlight: [],
    };
    const state = reattach(emptyTimeline, result);
    expect(state.entries.map((e) => e.id)).toEqual(["t1::you", "t1::orchestrator"]);
    expect(state.entries[1]?.status).toBe("complete");
  });

  it("resumes an in-flight turn as streaming", () => {
    const result: ReattachResult = {
      threads: [],
      inFlight: [
        {
          threadId: "th1",
          turnId: "t2",
          channel: "orchestrator",
          model: "claude",
          bodySoFar: "abc",
        },
      ],
    };
    const state = reattach(emptyTimeline, result);
    expect(state.entries[0]).toMatchObject({
      id: "t2::orchestrator",
      body: "abc",
      status: "streaming",
    });
    expect(isTurnRunning(state)).toBe(true);
  });
});

describe("turn-timeline live fold (#382 M2, task 1.1)", () => {
  it("appends deltas into one growing entry, then completes it", () => {
    const state = fold(emptyTimeline, [
      delta("t3", "Hel"),
      delta("t3", "lo"),
      complete("t3", "Hello."),
    ]);
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]).toMatchObject({ body: "Hello.", status: "complete", model: "claude" });
    expect(isTurnRunning(state)).toBe(false);
  });

  it("marks an interrupted turn truthfully, keeping its partial body", () => {
    const state = fold(emptyTimeline, [
      delta("t4", "partial…"),
      {
        kind: "ask-interrupted",
        threadId: "th1",
        turnId: "t4",
        channel: "orchestrator",
        reason: "stopped",
      },
    ]);
    expect(state.entries[0]).toMatchObject({ body: "partial…", status: "interrupted" });
    expect(isTurnRunning(state)).toBe(false);
  });
});

describe("turn-timeline reattach + live continuity (#382 M2, task 1.3)", () => {
  it("does not double-render a caught-up event across a reattach", () => {
    // Live streamed some deltas; then a reconnect re-issues reattach with the same in-flight turn.
    let state = fold(emptyTimeline, [delta("t5", "abcd")]);
    const result: ReattachResult = {
      threads: [],
      inFlight: [
        {
          threadId: "th1",
          turnId: "t5",
          channel: "orchestrator",
          model: "claude",
          bodySoFar: "ab",
        },
      ],
    };
    state = reattach(state, result);
    // ONE entry, and the longer live body wins — reattach's older snapshot never shrinks it.
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]?.body).toBe("abcd");
    // A further delta continues from the live body exactly once.
    state = foldStreamEvent(state, delta("t5", "ef"));
    expect(state.entries[0]?.body).toBe("abcdef");
    expect(state.entries).toHaveLength(1);
  });

  it("a completed turn survives a later in-flight reattach snapshot (no resurrection)", () => {
    let state = fold(emptyTimeline, [delta("t6", "done body"), complete("t6", "done body")]);
    state = reattach(state, {
      threads: [],
      inFlight: [
        {
          threadId: "th1",
          turnId: "t6",
          channel: "orchestrator",
          model: "claude",
          bodySoFar: "done",
        },
      ],
    });
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]).toMatchObject({ status: "complete", body: "done body" });
  });
});
