import { describe, expect, it } from "vitest";
import type { HarnessEvent } from "./harness";
import { createHarnessTranscriptFold, harnessEventsToRows } from "./harness-transcript";

// The incremental fold's ONE load-bearing property: taking a snapshot mid-turn must not change
// what the turn ends up projecting. A live turn reads `rows()` after (almost) every event, so a
// `rows()` that settled or consumed state would corrupt every later snapshot — silently, since
// the rows would still LOOK like a transcript. So the assertion is per-prefix equivalence: after
// event N, the incremental fold's snapshot must equal `harnessEventsToRows(events[0..N])`, the
// from-scratch projection nothing else in the codebase shares state with.
//
// Positive control (run 2026-08-31): making `rows()` settle the open turn (calling the
// destructive `flushTurn` instead of the non-destructive `buildTurnRow`) reddens both tests —
// the first at prefix 2, the second at prefix 1.

type BaseKeys = "seq" | "harness" | "sessionId" | "turnId" | "receivedAt" | "native";
type EventInput = HarnessEvent extends infer E
  ? E extends HarnessEvent
    ? Omit<E, BaseKeys>
    : never
  : never;

function events(
  parts: readonly (EventInput & { readonly turnId?: string | null })[],
): HarnessEvent[] {
  return parts.map(({ turnId, ...partial }, index) => ({
    seq: index + 1,
    harness: "claude-code",
    sessionId: "s1",
    turnId: turnId === undefined ? "harness-turn" : turnId,
    receivedAt: 1_700_000_000_000 + index * 10,
    native: { raw: index },
    ...partial,
  })) as HarnessEvent[];
}

/**
 * Snapshot the incremental fold after every event and compare each one, at the moment it was
 * taken, against a from-scratch fold of the same prefix. Cloning pins the snapshot's content at
 * capture time (the fold hands out live block objects on purpose — see the ponytail note on
 * `HarnessTranscriptFold`), so a later mutation cannot repair an already-wrong snapshot.
 */
function expectIncrementalMatchesBatch(
  stream: readonly HarnessEvent[],
  options?: { readonly turnId: string },
): void {
  const fold = createHarnessTranscriptFold(options);
  const snapshots: unknown[] = [];
  for (const event of stream) {
    fold.push(event);
    snapshots.push(structuredClone(fold.rows()));
  }
  stream.forEach((_event, index) => {
    expect(snapshots[index], `snapshot after event ${index + 1}`).toEqual(
      harnessEventsToRows(stream.slice(0, index + 1), options),
    );
  });
}

describe("createHarnessTranscriptFold", () => {
  it("matches a from-scratch projection at every prefix of a representative event mix", () => {
    // Every arm the projector models, in shapes that exercise its state machine: an open
    // thought closed by a message, deltas that accumulate then settle, a fenced block split out
    // of prose, a tool that completes, a denial that matches an open call and one that does
    // not, a compaction that flushes a segment mid-turn, and a completed terminal whose
    // finalText is only used when the turn produced no prose.
    expectIncrementalMatchesBatch(
      events([
        {
          kind: "session.started",
          model: "claude",
          cwd: "/repo",
          tools: ["Read"],
          apiKeySource: "oauth",
        },
        { kind: "thinking.delta", text: "weigh " },
        { kind: "thinking.delta", text: "the diff" },
        { kind: "thinking.message", text: "Weighed the diff." },
        { kind: "text.delta", text: "Here is " },
        {
          kind: "text.delta",
          text: "the read:\n\n```ts path=src/a.ts\nconst a = 1;\n```\n\nDone.",
        },
        {
          kind: "tool.started",
          call: {
            id: "call-1",
            name: "Read",
            input: { file_path: "src/a.ts" },
            parentToolCallId: null,
            kind: "read",
          },
        },
        { kind: "tool.output", callId: "call-1", ok: true, output: {}, text: "const a = 1;\nmore" },
        {
          kind: "tool.started",
          call: {
            id: "call-2",
            name: "Bash",
            input: { command: "rm -rf /" },
            parentToolCallId: null,
            kind: "exec",
          },
        },
        { kind: "tool.denied", callId: "call-2", toolName: "Bash", by: "policy", reason: "no" },
        { kind: "tool.denied", callId: null, toolName: "Write", by: "user", reason: "not now" },
        { kind: "text.message", text: "Two paragraphs.\n\nSecond one.", parentToolCallId: null },
        { kind: "compact_boundary", trigger: "auto", preTokens: 100, postTokens: 10 },
        { kind: "passthrough", nativeKind: "unmodelled" },
        { kind: "text.delta", text: "After the compaction." },
        {
          kind: "tool.started",
          call: {
            id: "call-3",
            name: "Grep",
            input: { pattern: "todo" },
            parentToolCallId: null,
            kind: "search",
          },
        },
        {
          kind: "session.ended",
          outcome: { status: "completed", finalText: "After the compaction." },
        },
      ]),
      { turnId: "tn::orchestrator" },
    );
  });

  it("applies a turn id named AFTER a row settled to that row's id too", () => {
    // The turn id arrives late (no `turnId` option, and the harness only stamps one on the
    // fourth event) — but it ids the compaction row that settled before it. A fold that froze
    // the base id at first emit would keep `turn-1` there while the batch projection says
    // `harness-turn`, which is the drift this recipe exists to prevent.
    const stream = events([
      { kind: "text.delta", text: "Opening.", turnId: null },
      { kind: "compact_boundary", trigger: "manual", turnId: null },
      { kind: "text.delta", text: "Continuing.", turnId: null },
      {
        kind: "text.message",
        text: "Named at last.",
        parentToolCallId: null,
        turnId: "harness-turn",
      },
      { kind: "session.ended", outcome: { status: "cancelled", partial: true }, turnId: null },
    ]);
    expectIncrementalMatchesBatch(stream);
    const rows = harnessEventsToRows(stream);
    expect(rows.map((row) => row.id)).toEqual([
      "harness-turn",
      "compact-harness-turn-2",
      "harness-turn:segment:1",
    ]);
  });

  it("projects nothing until an event carries content", () => {
    const fold = createHarnessTranscriptFold({ turnId: "tn" });
    expect(fold.rows()).toEqual([]);
    fold.push(events([{ kind: "passthrough", nativeKind: "x" }])[0] as HarnessEvent);
    expect(fold.rows()).toEqual([]);
  });
});
