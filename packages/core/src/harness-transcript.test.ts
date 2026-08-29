import { describe, expect, it } from "vitest";
import type { HarnessEvent } from "./harness";
import { harnessEventsToRows } from "./harness-transcript";

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
function ev(
  partial: EventInput,
  envelope: { readonly receivedAt?: number; readonly turnId?: string | null } = {},
): HarnessEvent {
  return {
    seq: seq++,
    harness: "claude-code",
    sessionId: "s1",
    turnId: envelope.turnId === undefined ? "t1" : envelope.turnId,
    receivedAt: envelope.receivedAt ?? 0,
    native: null,
    ...partial,
  } as HarnessEvent;
}

const REPO = "/Volumes/ExternalNVMe/home/dev/rennet";
const HOME = "/Users/rai";

describe("harnessEventsToRows", () => {
  it("projects a coding turn: thinking → thought, tool call → action step, prose → body", () => {
    const rows = harnessEventsToRows([
      ev({ kind: "thinking.message", text: "I should read the file first." }),
      ev({
        kind: "tool.started",
        call: {
          id: "c1",
          name: "Read",
          input: { file_path: `${REPO}/src/a.ts` },
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
    ]);

    expect(rows).toHaveLength(1);
    const turn = rows[0];
    if (turn?.kind !== "turn") throw new Error("expected a turn row");
    expect(turn.speaker).toBe("orchestrator");
    expect(turn.status).toBe("complete");
    // thought block
    const thought = turn.preface?.find((s) => s.kind === "thought");
    expect(thought?.kind === "thought" && thought.text).toEqual(["I should read the file first."]);
    // action step: icon selector + verbatim arg + settled
    const action = turn.preface?.find((s) => s.kind === "action");
    if (action?.kind !== "action") throw new Error("expected an action step");
    expect(action.toolKind).toBe("read");
    expect(action.status).toBe("complete");
    // VERBATIM: the argument reads back as the harness used it. The reviewer's own machine
    // gets the real path; the wire projection is what rewrites it for a remote client.
    expect(action.detail).toBe(`${REPO}/src/a.ts`);
    // prose
    expect(turn.body?.some((b) => b.kind === "text" && b.text.includes("exports `a`"))).toBe(true);
  });

  it("keeps host paths VERBATIM in every tool arg and output — the store is the user's own", () => {
    const rows = harnessEventsToRows([
      ev({
        kind: "tool.started",
        call: {
          id: "c9",
          name: "Bash",
          input: { command: `cat ${HOME}/secret/creds.txt` },
          parentToolCallId: null,
          kind: "exec",
        },
      }),
      ev({
        kind: "tool.output",
        callId: "c9",
        ok: true,
        output: null,
        text: `opened ${HOME}/secret/creds.txt`,
      }),
      ev({ kind: "session.ended", outcome: { status: "completed", finalText: "" } }),
    ]);
    // The projector has no scrub hook at all now, so this is the whole claim: what the
    // harness printed is what the row carries. The R19 transport rule lives at the wire
    // (`projectCommandOutput`), proven in packages/server/src/projection.test.ts and the
    // remote-surface e2e. Deleting the scrub from `projectCommandOutput` reddens THOSE.
    const serialized = JSON.stringify(rows);
    expect(serialized).toContain(`${HOME}/secret/creds.txt`);
    expect(serialized).not.toContain("~/secret");
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
    if (boundary?.kind !== "compact-boundary") throw new Error("expected a compact boundary");
    expect(boundary.tokensBefore).toBe(100);
    expect(boundary.time).toBe("1970-01-01T00:00:00.000Z");
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

  it("preserves thought, prose, action, and fenced code in exact event order", () => {
    const fencedReply = [
      "The edit is small.",
      "",
      '```ts path="packages/core/src/a file.ts"',
      "export const answer = 42;",
      "```",
      "",
      "The caller stays unchanged.",
    ].join("\n");
    const rows = harnessEventsToRows([
      ev({ kind: "thinking.delta", text: "Read the " }, { receivedAt: 1_000 }),
      ev({ kind: "thinking.delta", text: "caller." }, { receivedAt: 1_400 }),
      ev(
        { kind: "text.message", text: "I found the call site.", parentToolCallId: null },
        { receivedAt: 2_500 },
      ),
      ev(
        {
          kind: "tool.started",
          call: {
            id: "c-ordered",
            name: "Read",
            input: { file_path: "packages/core/src/a file.ts" },
            parentToolCallId: null,
            kind: "read",
          },
        },
        { receivedAt: 3_000 },
      ),
      ev(
        {
          kind: "tool.output",
          callId: "c-ordered",
          ok: true,
          output: null,
          text: "export const answer = 42;",
        },
        { receivedAt: 3_500 },
      ),
      ev(
        { kind: "text.message", text: fencedReply, parentToolCallId: null },
        { receivedAt: 4_000 },
      ),
      ev(
        { kind: "session.ended", outcome: { status: "completed", finalText: fencedReply } },
        { receivedAt: 4_500 },
      ),
    ]);

    const turn = rows[0];
    if (turn?.kind !== "turn") throw new Error("expected a turn row");
    expect(turn.id).toBe("t1");
    expect(turn.time).toBe("1970-01-01T00:00:01.000Z");
    expect(turn.blocks?.map((block) => block.kind)).toEqual([
      "thought",
      "text",
      "action",
      "text",
      "code",
      "text",
    ]);
    expect(turn.blocks?.[0]).toMatchObject({
      kind: "thought",
      seconds: 1.5,
      text: ["Read the caller."],
    });
    expect(turn.blocks?.[2]).toMatchObject({
      kind: "action",
      status: "complete",
      doneDetail: "export const answer = 42;",
    });
    expect(turn.blocks?.[4]).toEqual({
      kind: "code",
      path: "packages/core/src/a file.ts",
      lang: "ts",
      code: "export const answer = 42;",
    });
  });

  it("keeps a fenced block with no path and does not invent code metadata", () => {
    const rows = harnessEventsToRows([
      ev(
        {
          kind: "text.message",
          text: ["```json", '{"ok":true}', "```"].join("\n"),
          parentToolCallId: null,
        },
        { receivedAt: Number.NaN },
      ),
    ]);
    const turn = rows[0];
    if (turn?.kind !== "turn") throw new Error("expected a turn row");
    expect(turn.blocks).toEqual([{ kind: "code", path: "", lang: "json", code: '{"ok":true}' }]);
    expect(turn.time).toBeUndefined();

    const withBarePath = harnessEventsToRows([
      ev({
        kind: "text.message",
        text: ["```tsx packages/app-ui/src/chat/turn.tsx", "export function Turn() {}", "```"].join(
          "\n",
        ),
        parentToolCallId: null,
      }),
    ])[0];
    expect(withBarePath?.kind === "turn" ? withBarePath.blocks?.[0] : undefined).toEqual({
      kind: "code",
      path: "packages/app-ui/src/chat/turn.tsx",
      lang: "tsx",
      code: "export function Turn() {}",
    });
  });

  it("settles streamed text in place instead of duplicating the final message", () => {
    const rows = harnessEventsToRows([
      ev({ kind: "text.delta", text: "Hel" }),
      ev({ kind: "text.delta", text: "lo" }),
      ev({ kind: "text.message", text: "Hello", parentToolCallId: null }),
      ev({ kind: "session.ended", outcome: { status: "completed", finalText: "Hello" } }),
    ]);
    const turn = rows[0];
    expect(turn?.kind === "turn" ? turn.blocks : undefined).toEqual([
      { kind: "text", text: "Hello" },
    ]);
  });

  it("leaves a settled thought duration absent when receivedAt cannot reveal its start", () => {
    const rows = harnessEventsToRows([
      ev(
        { kind: "thinking.message", text: "The harness sent only the settled block." },
        { receivedAt: 5_000 },
      ),
      ev(
        { kind: "session.ended", outcome: { status: "completed", finalText: "done" } },
        { receivedAt: 9_000 },
      ),
    ]);
    const turn = rows[0];
    if (turn?.kind !== "turn") throw new Error("expected a turn row");
    const thought = turn.blocks?.[0];
    expect(thought?.kind).toBe("thought");
    expect(thought).not.toHaveProperty("seconds");
  });

  it("keeps the turn row id stable and lets the public ask id override the harness id", () => {
    const delta = ev(
      { kind: "text.delta", text: "partial" },
      { receivedAt: 1_000, turnId: "harness-turn-9" },
    );
    const ended = ev(
      { kind: "session.ended", outcome: { status: "completed", finalText: "partial" } },
      { receivedAt: 2_000, turnId: "harness-turn-9" },
    );

    expect(harnessEventsToRows([delta])[0]?.id).toBe("harness-turn-9");
    expect(harnessEventsToRows([delta, ended])[0]?.id).toBe("harness-turn-9");
    expect(harnessEventsToRows([delta, ended], { turnId: "review-ask-turn-4" })[0]?.id).toBe(
      "review-ask-turn-4",
    );

    const withoutHarnessId = ev(
      { kind: "text.message", text: "fallback", parentToolCallId: null },
      { turnId: null },
    );
    expect(harnessEventsToRows([withoutHarnessId])[0]?.id).toBe(`turn-${withoutHarnessId.seq}`);
  });
});
