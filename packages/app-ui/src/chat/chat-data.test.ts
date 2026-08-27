// C07 chat-data reducer unit tests. The DOM tests drive the whole dock; these pin the
// pure fold's load-bearing branches so a regression reddens HERE, fast, with a clear cause.
import type { ReattachResult, ReviewAskStreamEvent } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { foldAskStream, reattachToRows } from "./chat-data";

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
    expect(rows[0]?.speaker).toBe("orchestrator");
    expect(rows[0]?.status).toBe("complete");
    expect(rows[0]?.paragraphs.join(" ")).toContain("the answer");
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
