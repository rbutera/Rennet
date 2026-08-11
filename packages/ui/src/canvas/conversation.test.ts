import { describe, expect, it } from "vitest";
import { DEFAULT_ASK_MODE } from "./ask";
import {
  addMessage,
  answerInThread,
  askInThread,
  buildConversationQuestion,
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

describe("composing the live question (the multi-turn carrier over review.ask)", () => {
  it("a first ask scopes to the anchor and carries no transcript", () => {
    const question = buildConversationQuestion(LINE_ANCHOR, [], "why fail open?");
    expect(question).toBe(
      "The reviewer is discussing line src/rate/bucket.ts:14 in this code review.\n\n" +
        "The reviewer asks: why fail open?",
    );
    // No transcript header when the thread is fresh.
    expect(question).not.toContain("Conversation so far:");
  });

  it("a follow-up folds the prior you/harness turns in so the stateless turn has context", () => {
    let thread = askInThread(openThread("t1", LINE_ANCHOR), "m1", "why fail open?");
    thread = answerInThread(thread, "m2", "Orchestrator · Claude", "outage must not spread");
    const question = buildConversationQuestion(
      thread.anchor,
      thread.messages,
      "but what caps the blast radius?",
    );
    // The anchor scope, the whole conversation so far (labelled by speaker), and the
    // new question all travel in the ONE string the stateless orchestrator turn reads.
    expect(question).toContain("discussing line src/rate/bucket.ts:14");
    expect(question).toContain("Conversation so far:");
    expect(question).toContain("You: why fail open?");
    expect(question).toContain("Orchestrator · Claude: outage must not spread");
    expect(question).toContain("The reviewer now asks: but what caps the blast radius?");
    // The new question is the LAST thing — it comes after the transcript.
    expect(question.lastIndexOf("but what caps the blast radius?")).toBeGreaterThan(
      question.indexOf("Conversation so far:"),
    );
  });

  it("labels a harness message with no model as a generic assistant", () => {
    const priorNoModel = [{ id: "m1", author: "harness" as const, body: "an answer" }];
    const question = buildConversationQuestion(LINE_ANCHOR, priorNoModel, "and then?");
    expect(question).toContain("Assistant: an answer");
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
