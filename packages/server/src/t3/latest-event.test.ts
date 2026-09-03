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
    const idle = projectLatestEvent(quiet, 1_000 + 41_000);
    expect(idle).toEqual({ kind: "idle", text: "quiet for 41 s", at: 42_000 });
  });

  it("has no line at all for a thread that has produced nothing", () => {
    expect(projectLatestEvent(thread(), 1_000)).toBeUndefined();
    // An assistant message with no text yet is not a line either.
    expect(projectLatestEvent(thread({ messages: [said(1, "")] }), 2)).toBeUndefined();
  });

  it("shows the raw fragment while a tool call is still streaming its input", () => {
    expect(toolLine(tool(0, 'Read: {"file_path":"/repo/src/fo'), "/repo")).toBe(
      'reading {"file_path":"/repo/src/fo',
    );
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
