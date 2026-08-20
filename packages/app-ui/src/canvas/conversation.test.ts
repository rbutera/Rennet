import { describe, expect, it } from "vitest";
import { DEFAULT_ASK_MODE } from "./ask";
import {
  addMessage,
  answerInThread,
  askInThread,
  buildConversationQuestion,
  type ConversationAnchor,
  chunkAnchorKey,
  demoConversationThread,
  fragmentAnchorKey,
  groupThreadsByAnchor,
  isPrivate,
  lineAnchorKey,
  openThread,
  promoteMessage,
  rangeAnchorKey,
  threadContentForPublish,
  threadMarginKey,
  threadRoute,
} from "./conversation";

describe("anchor keys are injective across kinds (#36 F4)", () => {
  it("every key is namespaced by its kind, so no cross-kind collision is possible", () => {
    expect(lineAnchorKey("f", "additions", 5).startsWith("line|")).toBe(true);
    expect(rangeAnchorKey("f", "additions", 5, 7).startsWith("range|")).toBe(true);
    expect(chunkAnchorKey("f").startsWith("chunk|")).toBe(true);
    expect(fragmentAnchorKey("t", "m").startsWith("fragment|")).toBe(true);
  });

  it("a chunk path that mimics a line's old shape does not collide with that line", () => {
    // Pre-fix, line keys were `${path}#R:${line}` and chunk keys the raw path, so a file
    // literally named `foo#R:5` collided with line 5 of `foo`. Carrying the kind removes it.
    expect(chunkAnchorKey("foo#R:5")).not.toBe(lineAnchorKey("foo", "additions", 5));
  });

  it("a FRAGMENT key cannot collide when a component contains the delimiter (#36 F-B)", () => {
    // Both components are unconstrained strings; a raw `|` join would make these two
    // DIFFERENT tuples produce the SAME key. JSON encoding keeps them distinct. RED-proof:
    // revert to `fragment|${parent}|${message}` and this reddens.
    expect(fragmentAnchorKey("parent|message", "tail")).not.toBe(
      fragmentAnchorKey("parent", "message|tail"),
    );
    // And a `|` in a path never collides a line with anything, because side + line right-parse.
    expect(lineAnchorKey("we|ird.ts", "additions", 5)).not.toBe(
      lineAnchorKey("we", "additions", 5),
    );
  });
});

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

  it("carries the anchor SIDE into the question, so the two diff sides ask DIFFERENT things (#36 F1)", () => {
    // Two anchors identical but for side — a question on the deleted line and one on the
    // added line at the same number. The KEY being injective is not enough: the model
    // reads the question, so the side must travel in the question text.
    const deletion: ConversationAnchor = {
      kind: "line",
      label: "keys.ts:11",
      key: "line|keys.ts|deletions|11",
      side: "deletions",
    };
    const addition: ConversationAnchor = {
      kind: "line",
      label: "keys.ts:11",
      key: "line|keys.ts|additions|11",
      side: "additions",
    };
    const qDel = buildConversationQuestion(deletion, [], "why?");
    const qAdd = buildConversationQuestion(addition, [], "why?");
    expect(qDel).not.toBe(qAdd);
    expect(qDel).toContain("REMOVED");
    expect(qAdd).toContain("ADDED");
  });

  it("carries a FRAGMENT's referenced text into the question (#36 F2)", () => {
    // The fragment anchors to a specific sentence; that sentence must reach the model,
    // else the sub-thread's "what do you mean?" is unanswerable.
    const fragment: ConversationAnchor = {
      kind: "fragment",
      label: "keys.ts:11 · reply",
      key: "fragment|thread-1|m2",
      context: "the fail-open path is unbounded",
    };
    const question = buildConversationQuestion(fragment, [], "what do you mean?");
    expect(question).toContain("the fail-open path is unbounded");
    expect(question).toContain("what do you mean?");
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
    expect(thread.anchor.key).toBe("range|src/rate/bucket.ts|additions|44|47");
    expect(thread.anchor.side).toBe("additions");
    expect(thread.messages[0]?.author).toBe("you");
    expect(thread.messages[1]?.author).toBe("harness");
    expect(thread.messages[1]?.model).toBe("Claude Code");
    // Even the fixture's content never publishes on its own.
    expect(threadContentForPublish([thread])).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Criterion 2 as an INVARIANT over ALL paths (issue #36; lead's mandate). "Promotion
// is the only private→published door" is a claim about EVERY OTHER path, not about
// `promoteMessage`. So these tests do not show promotion works — they plant a unique
// CANARY in every message of a private thread, at every anchor kind, then scan every
// publish-bound value the model can produce and assert NO canary appears without a
// deliberate promotion. A private conversation leaking into published output is the
// review-side twin of an egress leak; multiplying the anchor kinds by four multiplies
// the places a thread can exist, so the guard has to hold at each of them.
//
// RED-PROOF (run once, restored): making `threadContentForPublish` fold message
// bodies into its output — the realistic "second door" (someone deciding to include
// thread context in the PR) — makes a canary appear and reddens the first two tests.
// If it could not distinguish "the only door" from "a door", it would not fire.
// ─────────────────────────────────────────────────────────────────────────────
describe("criterion 2 — a private thread's content never reaches publish, by ANY route", () => {
  const KINDS = ["line", "range", "chunk", "fragment"] as const;

  // A private thread per anchor kind, each carrying a unique canary in BOTH a "you"
  // message and a harness message — so a leak through any role at any kind is a
  // detectable string, and a passing scan is evidence about all four at once.
  function threadWithCanary(kind: (typeof KINDS)[number]): {
    thread: ReturnType<typeof openThread>;
    canary: string;
  } {
    const canary = `CANARY-${kind}-DO-NOT-PUBLISH`;
    let thread = openThread(`t-${kind}`, { kind, label: `subject ${kind}`, key: `anchor#${kind}` });
    thread = askInThread(thread, `${kind}-you`, `a private question ${canary}`);
    thread = answerInThread(thread, `${kind}-ai`, "Claude Code", `a private answer ${canary}`);
    return { thread, canary };
  }

  const built = KINDS.map(threadWithCanary);
  const threads = built.map((entry) => entry.thread);
  const canaries = built.map((entry) => entry.canary);
  // The line-kind thread, guarded once so the promotion tests read it without
  // tripping noUncheckedIndexedAccess (KINDS is non-empty by construction).
  const lineEntry = built[0];
  if (!lineEntry) throw new Error("expected a line-kind thread");

  it("the passive publish contribution is empty and canary-free at every anchor kind", () => {
    // The one value threads contribute to a publish payload, across all four kinds.
    const contributed = threadContentForPublish(threads);
    expect(contributed).toEqual([]);
    const serialized = JSON.stringify(contributed);
    for (const canary of canaries) expect(serialized).not.toContain(canary);
  });

  it("NO thread content reaches any publish-bound value without a deliberate promotion", () => {
    // Scan EVERY value the model produces from threads that could plausibly reach a
    // boundary — the passive publish slice AND the right-margin layout functions —
    // with NOTHING promoted. A new leak path (a second door) would surface a canary
    // here and redden this: it tests "promotion is the ONLY door", not "a door".
    const publishBound = JSON.stringify({
      contribution: threadContentForPublish(threads),
      groupKeys: [...groupThreadsByAnchor(threads).keys()],
      marginKeys: threads.map(threadMarginKey),
    });
    for (const canary of canaries) expect(publishBound).not.toContain(canary);
  });

  it("promotion is the door — and it carries ONLY the promoted message, never its siblings", () => {
    const { thread, canary } = lineEntry;
    // A SECOND harness message with its own distinct canary that is NOT promoted.
    const grown = answerInThread(
      thread,
      "sibling",
      "Claude Code",
      "a sibling SIBLING-CANARY answer",
    );
    const event = promoteMessage(grown, "line-ai", "finding");
    expect(event).not.toBeNull();
    // The promoted event carries the promoted message's body…
    expect(event?.body).toContain(canary);
    // …and nothing from the sibling message the reviewer did NOT promote.
    expect(JSON.stringify(event)).not.toContain("SIBLING-CANARY");
  });

  it("even after promotion, the passive path STILL leaks nothing (promotion is a copy out)", () => {
    // Promoting a message must not retro-open the passive door: the thread stays
    // private and its content still never appears in the passive contribution.
    const { thread } = lineEntry;
    promoteMessage(thread, "line-ai", "finding");
    const serialized = JSON.stringify(threadContentForPublish(threads));
    for (const canary of canaries) expect(serialized).not.toContain(canary);
  });
});
