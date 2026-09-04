import { describe, expect, it } from "vitest";
import {
  capLine,
  LATEST_EVENT_MAX_CHARS,
  lastSentence,
  projectLatestEvent,
  type ThreadLike,
  toolLine,
} from "./latest-event";

// The projector is pure: these are plain objects shaped like T3's thread projection.
// The wire shape itself is proven by client.test.ts against the real bundle.

const ISO = (ms: number) => new Date(ms).toISOString();

const tool = (at: number, detail: string, turnId: string | null = "turn-1") => ({
  tone: "tool",
  kind: "tool.updated",
  summary: "Tool",
  payload: { itemType: "file_change", detail },
  turnId,
  createdAt: ISO(at),
});

/** One tool CALL's lifecycle rows, as `ProviderRuntimeIngestion` shapes them: started and
 *  completed share the `tool` tone and are paired only by `toolCallId`. */
const toolStarted = (at: number, detail: string, toolCallId: string) => ({
  tone: "tool",
  kind: "tool.started",
  summary: "Tool started",
  payload: { itemType: "file_change", detail, toolCallId, status: "inProgress" },
  turnId: "turn-1",
  createdAt: ISO(at),
});

const toolFinished = (
  at: number,
  detail: string,
  toolCallId: string,
  status: "completed" | "declined" = "completed",
) => ({
  tone: "tool",
  kind: "tool.completed",
  summary: "Tool",
  payload: { itemType: "file_change", detail, toolCallId, status },
  turnId: "turn-1",
  createdAt: ISO(at),
});

const said = (at: number, text: string, turnId: string | null = "turn-1") => ({
  role: "assistant",
  text,
  turnId,
  updatedAt: ISO(at),
});

const thread = (over: Partial<ThreadLike> = {}): ThreadLike => ({
  latestTurn: { turnId: "turn-1" },
  activities: [],
  messages: [],
  ...over,
});

describe("projectLatestEvent", () => {
  it("names the file a Read is reading, relative to the checkout", () => {
    const latest = projectLatestEvent(
      thread({ activities: [tool(1_000, 'Read: {"file_path":"/repo/src/foo.ts"}')] }),
      1_500,
      { repoRoot: "/repo" },
    );
    expect(latest).toEqual({ kind: "tool", text: "reading src/foo.ts", at: 1_000 });
  });

  it("names the command a Bash is running", () => {
    expect(toolLine(tool(0, "Bash: git diff --stat"))).toBe("running git diff --stat");
  });

  it("says editing and searching for the tools that do those things", () => {
    expect(toolLine(tool(0, 'Edit: {"file_path":"/r/a.ts"}'), "/r")).toBe("editing a.ts");
    expect(toolLine(tool(0, 'Grep: {"pattern":"createSession"}'))).toBe("searching createSession");
  });

  it("keeps T3's own detail for a tool it has no plain word for, rather than inventing one", () => {
    expect(toolLine(tool(0, "mcp__weather__forecast: Berlin"))).toBe(
      "mcp__weather__forecast: Berlin",
    );
  });

  it("shows the last sentence of what the seat said", () => {
    const latest = projectLatestEvent(
      thread({ messages: [said(2_000, "I read the diff. Now I will draft the board.")] }),
      2_100,
    );
    expect(latest).toEqual({
      kind: "text",
      text: "Now I will draft the board.",
      at: 2_000,
    });
  });

  it("takes the newest of the tool calls and the text, whichever it is", () => {
    const base = thread({
      activities: [tool(1_000, "Bash: git log")],
      messages: [said(3_000, "Drafting now.")],
    });
    expect(projectLatestEvent(base, 3_100)?.kind).toBe("text");
    expect(
      projectLatestEvent({ ...base, activities: [tool(5_000, "Bash: git log")] }, 5_100)?.kind,
    ).toBe("tool");
  });

  it("ignores activity and text from an earlier turn", () => {
    const latest = projectLatestEvent(
      thread({
        latestTurn: { turnId: "turn-2" },
        activities: [tool(9_000, "Bash: stale", "turn-1"), tool(1_000, "Bash: fresh", "turn-2")],
      }),
      1_100,
    );
    expect(latest?.text).toBe("running fresh");
  });

  it("caps a long line at 120 characters with an honest marker", () => {
    const long = `Bash: ${"x".repeat(400)}`;
    const latest = projectLatestEvent(thread({ activities: [tool(1_000, long)] }), 1_100);
    expect(latest?.text.length).toBe(LATEST_EVENT_MAX_CHARS);
    expect(latest?.text.endsWith("…")).toBe(true);
    // Positive control on the cap: the uncapped subject really is longer than the cap.
    expect(long.length).toBeGreaterThan(LATEST_EVENT_MAX_CHARS);
  });

  it("goes idle and says for how long once the thread has been quiet", () => {
    const quiet = thread({ activities: [tool(1_000, "Bash: git log")] });
    expect(projectLatestEvent(quiet, 1_000 + 19_999)?.kind).toBe("tool");
    // Counted in TEN-SECOND steps (review finding 7): at one-second resolution the text is
    // a new string every second, and every new string republishes the whole preparation
    // snapshot for as long as the lane stays quiet.
    expect(projectLatestEvent(quiet, 1_000 + 41_000)).toEqual({
      kind: "idle",
      text: "quiet for 40 s",
      at: 42_000,
    });
    // The whole ten-second span reads the same, which is what makes it publish once.
    for (const extra of [40_000, 44_000, 49_999]) {
      expect(projectLatestEvent(quiet, 1_000 + extra)?.text).toBe("quiet for 40 s");
    }
    // And it does advance — a bucket that never changed would be a frozen line.
    expect(projectLatestEvent(quiet, 1_000 + 50_000)?.text).toBe("quiet for 50 s");
  });

  it("has no line at all for a thread that has produced nothing", () => {
    expect(projectLatestEvent(thread(), 1_000)).toBeUndefined();
    // An assistant message with no text yet is not a line either.
    expect(projectLatestEvent(thread({ messages: [said(1, "")] }), 2)).toBeUndefined();
  });

  // ── A finished tool call is not in flight (review finding 5) ──────────────
  //
  // T3 emits started, updated and completed with the SAME `tool` tone, so tone alone made
  // "reading src/foo.ts" outlive the read by the whole rest of the turn.

  it("falls back to the seat's latest words once its tool call has completed", () => {
    const running = thread({
      messages: [said(1_000, "Looking at the auth seam.")],
      activities: [toolStarted(2_000, 'Read: {"file_path":"/repo/src/foo.ts"}', "call-1")],
    });
    // The premise: while the call IS in flight the tool line wins, so what changes below
    // is the lifecycle and nothing else.
    expect(projectLatestEvent(running, 2_500, { repoRoot: "/repo" })).toEqual({
      kind: "tool",
      text: "reading src/foo.ts",
      at: 2_000,
    });

    const finished = thread({
      messages: running.messages,
      activities: [
        ...running.activities,
        toolFinished(3_000, 'Read: {"file_path":"/repo/src/foo.ts"}', "call-1"),
      ],
    });
    expect(projectLatestEvent(finished, 3_500, { repoRoot: "/repo" })).toEqual({
      kind: "text",
      text: "Looking at the auth seam.",
      at: 1_000,
    });
  });

  it("treats a DENIED call as finished too, and keeps a second call in flight", () => {
    const mixed = thread({
      messages: [said(1_000, "Checking the diff.")],
      activities: [
        toolStarted(2_000, "Bash: git log", "call-1"),
        toolFinished(2_500, "Bash: git log", "call-1", "declined"),
        toolStarted(3_000, "Bash: git diff --stat", "call-2"),
      ],
    });
    // The declined call is gone from the line; the one still open is what the seat is doing.
    expect(projectLatestEvent(mixed, 3_500)).toEqual({
      kind: "tool",
      text: "running git diff --stat",
      at: 3_000,
    });
  });

  it("a completed tool still counts as activity, so the lane is not called quiet", () => {
    // Idleness is a fact about the THREAD, not about the line on screen. Without this, a
    // turn whose last act was a completed tool and which said nothing would read "quiet
    // for 0 s" — or nothing at all — the instant the call landed.
    const done = thread({
      activities: [
        toolStarted(1_000, "Bash: git log", "call-1"),
        toolFinished(40_000, "Bash: git log", "call-1"),
      ],
    });
    expect(projectLatestEvent(done, 45_000)).toBeUndefined();
    expect(projectLatestEvent(done, 70_000)).toEqual({
      kind: "idle",
      text: "quiet for 30 s",
      at: 70_000,
    });
  });

  it("says only the verb while a tool call is still streaming its input", () => {
    // It used to say `reading {"file_path":"/repo/src/fo` — the raw fragment, on the
    // grounds that it beat guessing what the input would become. It does not: a half-sent
    // payload is still a payload where the seat's speech goes (#819), and this line is
    // read on the bench next to four others. "reading" is true for the whole of the call
    // and becomes "reading src/foo.ts" the moment the input closes.
    expect(toolLine(tool(0, 'Read: {"file_path":"/repo/src/fo'), "/repo")).toBe("reading");
    expect(toolLine(tool(0, 'Read: {"file_path":"/repo/src/foo.ts"}'), "/repo")).toBe(
      "reading src/foo.ts",
    );
  });

  // ── #819: a payload is not speech ──────────────────────────────────────────
  // The 0.7.0 drive's bench had Noise saying `{"document":null,"elements":[]}` and
  // Decisions saying `StructuredOutput: {"elements":[{"id":"sec-dead-…`. Both are the
  // structured-output call's INPUT — the board the seat is handing back — rendered where
  // its sentence goes. Each case below is the shape one of those lines actually had.

  it("projects a structured-output call as a receipt, never as the board it carries", () => {
    const board = JSON.stringify({
      document: null,
      elements: [{ id: "sec-dead-code", kind: "finding", title: "Dead code" }],
    });
    expect(toolLine(tool(0, `StructuredOutput: ${board}`))).toBe("returning the board");
    // The projector's own answer, not just the helper's — this is what reaches the lane.
    expect(
      projectLatestEvent(
        thread({ activities: [tool(1_000, `StructuredOutput: ${board}`)] }),
        1_000,
      ),
    ).toEqual({ kind: "tool", text: "returning the board", at: 1_000 });
  });

  it("says the tool's NAME, not its input, for a tool it has no verb for", () => {
    expect(toolLine(tool(0, 'SomeOtherTool: {"elements":[]}'))).toBe("SomeOtherTool");
  });

  it("falls back to T3's summary when the detail is nothing but a payload", () => {
    // Noise's line: T3 wrote the detail with no tool name in front of it, so there is not
    // even a name to fall back on. The activity's own summary is the last honest thing
    // this projector holds, and it is what the lane shows instead of the board.
    const payload = '{"document":null,"elements":[]}';
    expect(toolLine(tool(0, payload))).toBe("Tool");
  });

  it("yields to the seat's own words when the summary is a payload too", () => {
    // Nothing left to say about the call, so it says nothing and the assistant's last
    // sentence — the actual speech — is what the lane shows. Returning "" is the
    // projector's existing way of declining a line; `consider` drops an empty one.
    const payload = '{"document":null,"elements":[]}';
    const mute = { ...tool(2_000, payload), summary: payload };
    expect(toolLine(mute)).toBe("");
    expect(
      projectLatestEvent(
        thread({
          activities: [mute],
          messages: [said(1_000, "Nothing here is safely skippable.")],
        }),
        2_000,
      ),
    ).toEqual({ kind: "text", text: "Nothing here is safely skippable.", at: 1_000 });
  });
});

describe("capLine and lastSentence", () => {
  it("collapses whitespace and leaves a short line alone", () => {
    expect(capLine("  a\n  b  ")).toBe("a b");
  });

  it("returns the whole text when it has only one sentence", () => {
    expect(lastSentence("no terminator here")).toBe("no terminator here");
    expect(lastSentence("")).toBe("");
  });

  it("splits on ? and ! as well as .", () => {
    expect(lastSentence("Really? Yes!")).toBe("Yes!");
  });
});
