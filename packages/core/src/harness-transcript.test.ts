import { describe, expect, it } from "vitest";
import type { HarnessEvent } from "./harness";
import { harnessEventsToRows, type ScrubPath } from "./harness-transcript";

// Minimal event builder — stamps the envelope base every HarnessEvent carries. The input type
// distributes the Omit over each union arm so an object literal matches its own `kind` exactly
// (the built-in Omit over a union keeps only the shared keys, which rejects arm-specific fields).
type BaseKeys = "seq" | "harness" | "sessionId" | "turnId" | "receivedAt" | "native";
type EventInput = HarnessEvent extends infer E
  ? E extends HarnessEvent
    ? Omit<E, BaseKeys>
    : never
  : never;
let seq = 0;
function ev(partial: EventInput): HarnessEvent {
  return {
    seq: seq++,
    harness: "claude-code",
    sessionId: "s1",
    turnId: "t1",
    receivedAt: 0,
    native: null,
    ...partial,
  } as HarnessEvent;
}

// A scrub that maps a fake host root and the home dir to display tokens — the shape the
// server's R19 projection has, small enough to prove the choke point without the real ctx.
const scrub: ScrubPath = (text) =>
  text
    .split("/Volumes/ExternalNVMe/home/dev/rennet")
    .join("<rennet>")
    .split("/Users/rai")
    .join("~");

describe("harnessEventsToRows", () => {
  it("projects a coding turn: thinking → thought, tool call → action step, prose → body", () => {
    const rows = harnessEventsToRows(
      [
        ev({ kind: "thinking.message", text: "I should read the file first." }),
        ev({
          kind: "tool.started",
          call: {
            id: "c1",
            name: "Read",
            input: { file_path: "/Volumes/ExternalNVMe/home/dev/rennet/src/a.ts" },
            parentToolCallId: null,
            kind: "read",
          },
        }),
        ev({
          kind: "tool.output",
          callId: "c1",
          ok: true,
          output: null,
          text: "1  export const a = 1;",
        }),
        ev({
          kind: "text.message",
          text: "Read the file. It exports `a`.",
          parentToolCallId: null,
        }),
        ev({
          kind: "session.ended",
          outcome: { status: "completed", finalText: "Read the file. It exports `a`." },
        }),
      ],
      scrub,
    );

    expect(rows).toHaveLength(1);
    const turn = rows[0];
    if (turn?.kind !== "turn") throw new Error("expected a turn row");
    expect(turn.speaker).toBe("orchestrator");
    expect(turn.status).toBe("complete");
    // thought block
    const thought = turn.preface?.find((s) => s.kind === "thought");
    expect(thought?.kind === "thought" && thought.text).toEqual(["I should read the file first."]);
    // action step: icon selector + scrubbed arg + settled
    const action = turn.preface?.find((s) => s.kind === "action");
    if (action?.kind !== "action") throw new Error("expected an action step");
    expect(action.toolKind).toBe("read");
    expect(action.status).toBe("complete");
    expect(action.detail).toBe("<rennet>/src/a.ts"); // R19 scrub: host path → repo-relative
    // prose
    expect(turn.body?.some((b) => b.kind === "text" && b.text.includes("exports `a`"))).toBe(true);
  });

  it("R19 proof: a smuggled ~/secret host path in ANY tool arg or output is scrubbed", () => {
    const rows = harnessEventsToRows(
      [
        ev({
          kind: "tool.started",
          call: {
            id: "c9",
            name: "Bash",
            input: { command: "cat /Users/rai/secret/creds.txt" },
            parentToolCallId: null,
            kind: "exec",
          },
        }),
        ev({
          kind: "tool.output",
          callId: "c9",
          ok: true,
          output: null,
          text: "opened /Users/rai/secret/creds.txt",
        }),
        ev({ kind: "session.ended", outcome: { status: "completed", finalText: "" } }),
      ],
      scrub,
    );
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("/Users/rai");
    expect(serialized).toContain("~/secret/creds.txt"); // path survives as a scrubbed reference
  });

  it("a denied tool renders a denied action step", () => {
    const rows = harnessEventsToRows([
      ev({
        kind: "tool.denied",
        callId: null,
        toolName: "Bash",
        by: "policy",
        reason: "blocked by policy",
      }),
      ev({ kind: "session.ended", outcome: { status: "completed", finalText: "" } }),
    ]);
    const turn = rows[0];
    if (turn?.kind !== "turn") throw new Error("expected a turn row");
    const denied = turn.preface?.find((s) => s.kind === "action");
    expect(denied?.kind === "action" && denied.denied).toBe(true);
  });

  it("a compact boundary splits the turn and emits a compact-boundary row in order", () => {
    const rows = harnessEventsToRows([
      ev({ kind: "text.message", text: "before", parentToolCallId: null }),
      ev({ kind: "compact_boundary", trigger: "auto", preTokens: 100, postTokens: 20 }),
      ev({ kind: "text.message", text: "after", parentToolCallId: null }),
      ev({ kind: "session.ended", outcome: { status: "completed", finalText: "after" } }),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["turn", "compact-boundary", "turn"]);
    const boundary = rows[1];
    expect(boundary?.kind === "compact-boundary" && boundary.tokensBefore).toBe(100);
  });

  it("honest-empty: no transcript-bearing events project to no rows", () => {
    expect(harnessEventsToRows([])).toEqual([]);
    expect(
      harnessEventsToRows([
        ev({ kind: "session.started", model: "m", cwd: "/x", tools: [], apiKeySource: "oauth" }),
        ev({ kind: "session.ended", outcome: { status: "completed", finalText: "" } }),
      ]),
    ).toEqual([]);
  });
});
