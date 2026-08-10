import { describe, expect, it } from "vitest";
import { DEFAULT_ASK_MODE } from "./ask";
import {
  addMessage,
  answerInThread,
  askInThread,
  type ConversationAnchor,
  demoConversationThread,
  groupThreadsByAnchor,
  isPrivate,
  openThread,
  promoteMessage,
  threadContentForPublish,
  threadMarginKey,
  threadRoute,
} from "./conversation";

const LINE_ANCHOR: ConversationAnchor = {
  kind: "line",
  label: "src/rate/bucket.ts:14",
  key: "src/rate/bucket.ts#L14",
};

describe("opening a thread on an anchor", () => {
  it("opens a fresh, private, orchestrator-routed thread with no messages", () => {
    const thread = openThread("t1", LINE_ANCHOR);
    expect(thread.id).toBe("t1");
    expect(thread.anchor).toEqual(LINE_ANCHOR);
    expect(thread.messages).toHaveLength(0);
    // Private by default (blue), and routed to the orchestrator by default (#139).
    expect(thread.lane).toBe("blue");
    expect(isPrivate(thread)).toBe(true);
    expect(thread.route).toBe(DEFAULT_ASK_MODE);
    expect(threadRoute(thread)).toBe("orchestrator");
  });

  it("opens on a line, a range, a chunk, or a fragment — all one shape", () => {
    for (const kind of ["line", "range", "chunk", "fragment"] as const) {
      const thread = openThread("t", { kind, label: "x", key: `x#${kind}` });
      expect(thread.anchor.kind).toBe(kind);
      expect(isPrivate(thread)).toBe(true);
    }
  });
});

describe("growing a thread (ask → answer)", () => {
  it("appends a 'you' message when a question is asked", () => {
    const thread = askInThread(openThread("t1", LINE_ANCHOR), "m1", "why fail open?");
    expect(thread.messages).toEqual([{ id: "m1", author: "you", body: "why fail open?" }]);
  });

  it("appends a labelled harness answer after the question", () => {
    let thread = askInThread(openThread("t1", LINE_ANCHOR), "m1", "why?");
    thread = answerInThread(thread, "m2", "Claude Code", "because outage must not spread");
    expect(thread.messages).toHaveLength(2);
    expect(thread.messages[1]).toEqual({
      id: "m2",
      author: "harness",
      model: "Claude Code",
      body: "because outage must not spread",
    });
  });

  it("is pure — the input thread is never mutated", () => {
    const base = openThread("t1", LINE_ANCHOR);
    const grown = addMessage(base, { id: "m1", author: "you", body: "hi" });
    expect(base.messages).toHaveLength(0);
    expect(grown.messages).toHaveLength(1);
    expect(grown).not.toBe(base);
  });
});

describe("the privacy boundary — promotion is the only path out", () => {
  it("thread content is structurally excluded from every publish payload", () => {
    let thread = askInThread(openThread("t1", LINE_ANCHOR), "m1", "a secret research question");
    thread = answerInThread(thread, "m2", "Claude Code", "a private harness answer");
    // No amount of thread content reaches a publish payload — the slice is always empty.
    expect(threadContentForPublish([thread])).toEqual([]);
  });

  it("promoting a harness message yields a finding/draft-comment event at the anchor", () => {
    let thread = askInThread(openThread("t1", LINE_ANCHOR), "m1", "why?");
    thread = answerInThread(thread, "m2", "Claude Code", "the fail-open reasoning");

    const finding = promoteMessage(thread, "m2", "finding");
    expect(finding).toEqual({
      threadId: "t1",
      messageId: "m2",
      kind: "finding",
      anchor: LINE_ANCHOR,
      body: "the fail-open reasoning",
    });

    const draft = promoteMessage(thread, "m2", "draft-comment");
    expect(draft?.kind).toBe("draft-comment");
    expect(draft?.body).toBe("the fail-open reasoning");
  });

  it("promotion does NOT mutate the thread — it stays private", () => {
    const thread = answerInThread(
      askInThread(openThread("t1", LINE_ANCHOR), "m1", "q"),
      "m2",
      "Claude Code",
      "a",
    );
    const before = thread;
    promoteMessage(thread, "m2", "finding");
    // The thread is untouched: promotion copies a message out, it never turns the
    // conversation public.
    expect(thread).toBe(before);
    expect(isPrivate(thread)).toBe(true);
    expect(thread.messages).toHaveLength(2);
  });

  it("returns null when the message is not in the thread", () => {
    const thread = openThread("t1", LINE_ANCHOR);
    expect(promoteMessage(thread, "nope", "finding")).toBeNull();
  });
});

describe("right-margin placement — the diff column never reflows", () => {
  it("a thread's margin key is its anchor key", () => {
    const thread = openThread("t1", LINE_ANCHOR);
    expect(threadMarginKey(thread)).toBe("src/rate/bucket.ts#L14");
  });

  it("groups threads by anchor key in first-seen order", () => {
    const a = openThread("a", { kind: "line", label: "f:1", key: "f#L1" });
    const b = openThread("b", { kind: "line", label: "f:1", key: "f#L1" });
    const c = openThread("c", { kind: "chunk", label: "g", key: "g#chunk" });
    const groups = groupThreadsByAnchor([a, b, c]);
    expect([...groups.keys()]).toEqual(["f#L1", "g#chunk"]);
    expect(groups.get("f#L1")?.map((t) => t.id)).toEqual(["a", "b"]);
    expect(groups.get("g#chunk")?.map((t) => t.id)).toEqual(["c"]);
  });
});

describe("the demo fixture (behind the real typed boundary)", () => {
  it("is a real private thread with the fail-open conversation from frame 06", () => {
    const thread = demoConversationThread();
    expect(isPrivate(thread)).toBe(true);
    expect(thread.route).toBe("orchestrator");
    expect(thread.anchor.key).toBe("src/rate/bucket.ts#L44-47");
    expect(thread.messages[0]?.author).toBe("you");
    expect(thread.messages[1]?.author).toBe("harness");
    expect(thread.messages[1]?.model).toBe("Claude Code");
    // Even the fixture's content never publishes on its own.
    expect(threadContentForPublish([thread])).toEqual([]);
  });
});
