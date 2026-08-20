import { describe, expect, it } from "vitest";
import type { CollationDraft, CollationItem } from "./collation";
import {
  defaultLane,
  isPublished,
  isStageable,
  itemLane,
  laneCounts,
  localItems,
  publishedItems,
  publishReviewLabel,
  publishReviewType,
  stageItem,
} from "./staging";

// Issue #109 — the staging semantics + ink/blue material law + the publish
// roll-up. These are the load-bearing invariants a review's correctness rests on,
// so each is a red-provable property, not a smoke test.

const item = (id: string, type: CollationItem["type"], staged?: boolean): CollationItem => ({
  id,
  path: `${id}.ts`,
  type,
  raw: "",
  ...(staged !== undefined ? { staged } : {}),
});

describe("the per-type default lane", () => {
  it("only request-change defaults to ink; approve/comment/question default to blue", () => {
    expect(defaultLane("request-change")).toBe("ink");
    expect(defaultLane("approve")).toBe("blue");
    expect(defaultLane("comment")).toBe("blue");
    expect(defaultLane("question")).toBe("blue");
  });

  it("only comment/question are stageable — approve/request-change lanes are fixed", () => {
    expect(isStageable("comment")).toBe(true);
    expect(isStageable("question")).toBe(true);
    expect(isStageable("approve")).toBe(false);
    expect(isStageable("request-change")).toBe(false);
  });
});

describe("itemLane — the material law, with the two fixed invariants structural", () => {
  it("approve is ALWAYS blue — a staging flag can never publish it", () => {
    expect(itemLane(item("a", "approve"))).toBe("blue");
    // The flag is inert on a fixed type: approve never publishes even flagged staged.
    // If itemLane read the flag for approve, this reddens.
    expect(itemLane(item("a", "approve", true))).toBe("blue");
  });

  it("request-change is ALWAYS ink — even flagged un-staged it still travels", () => {
    expect(itemLane(item("r", "request-change"))).toBe("ink");
    expect(itemLane(item("r", "request-change", false))).toBe("ink");
  });

  it("comment/question default to blue (orchestrator) and go ink ONLY when staged", () => {
    expect(itemLane(item("c", "comment"))).toBe("blue");
    expect(itemLane(item("c", "comment", true))).toBe("ink");
    expect(itemLane(item("c", "comment", false))).toBe("blue");
    expect(itemLane(item("q", "question"))).toBe("blue");
    expect(itemLane(item("q", "question", true))).toBe("ink");
  });

  it("isPublished agrees with itemLane === ink", () => {
    expect(isPublished(item("r", "request-change"))).toBe(true);
    expect(isPublished(item("a", "approve", true))).toBe(false);
    expect(isPublished(item("c", "comment", true))).toBe(true);
    expect(isPublished(item("c", "comment"))).toBe(false);
  });
});

describe("publishedItems / localItems — approve never travels; blue stays local", () => {
  const draft: CollationDraft = [
    item("r", "request-change"),
    item("a", "approve"),
    item("c", "comment"), // unstaged → orchestrator → local
    item("s", "comment", true), // staged → ink
    item("q", "question"), // unstaged → local
  ];

  it("the published subset is exactly the ink lane, in draft order", () => {
    expect(publishedItems(draft).map((i) => i.id)).toEqual(["r", "s"]);
  });

  it("approve is NEVER in the published subset (the #109 core invariant)", () => {
    const approveOnly: CollationDraft = [item("a1", "approve"), item("a2", "approve", true)];
    expect(publishedItems(approveOnly)).toHaveLength(0);
  });

  it("the local subset is exactly the blue lane, in draft order", () => {
    expect(localItems(draft).map((i) => i.id)).toEqual(["a", "c", "q"]);
  });

  it("published and local partition the draft — disjoint, and together the whole set", () => {
    const pub = new Set(publishedItems(draft).map((i) => i.id));
    const loc = new Set(localItems(draft).map((i) => i.id));
    // Disjoint.
    for (const id of pub) expect(loc.has(id)).toBe(false);
    // Total: every item is in exactly one lane.
    expect(pub.size + loc.size).toBe(draft.length);
  });
});

describe("publishReviewType — the sign-off roll-up over the published subset", () => {
  it("request-changes when ANY published block is a request-change", () => {
    const draft: CollationDraft = [
      item("c", "comment", true),
      item("r", "request-change"),
      item("a", "approve"),
    ];
    expect(publishReviewType(draft)).toBe("request-changes");
  });

  it("comments when there is no request-change but a comment/question is staged", () => {
    const draft: CollationDraft = [item("a", "approve"), item("c", "comment", true)];
    expect(publishReviewType(draft)).toBe("comments");
    // A STAGED question rolls up as a plain comments review too.
    expect(publishReviewType([item("q", "question", true)])).toBe("comments");
  });

  it("NULL for an approve-only draft — approve never produces a published review", () => {
    expect(publishReviewType([item("a", "approve"), item("a2", "approve", true)])).toBeNull();
  });

  it("NULL when every comment/question stayed with the orchestrator (unstaged)", () => {
    const draft: CollationDraft = [
      item("c", "comment"),
      item("q", "question"),
      item("a", "approve"),
    ];
    // Nothing was staged and there is no request-change → nothing to publish.
    expect(publishReviewType(draft)).toBeNull();
  });

  it("NULL for an empty draft", () => {
    expect(publishReviewType([])).toBeNull();
  });

  it("approve can never escalate the roll-up to an approval (unlike the engine event twin)", () => {
    // The whole #109 reshape in one assertion: a draft that is approve + a staged
    // comment rolls up to `comments`, NOT to anything approval-flavoured — approve
    // is simply not in the published set the roll-up reads.
    expect(publishReviewType([item("a", "approve"), item("c", "comment", true)])).toBe("comments");
  });
});

describe("stageItem — the stage/keep-local toggle", () => {
  const draft: CollationDraft = [
    item("c", "comment"),
    item("a", "approve"),
    item("r", "request-change"),
  ];

  it("stages a comment (blue → ink) and unstages it back", () => {
    const staged = stageItem(draft, "c", true);
    expect(itemLane(staged[0] as CollationItem)).toBe("ink");
    const unstaged = stageItem(staged, "c", false);
    expect(itemLane(unstaged[0] as CollationItem)).toBe("blue");
  });

  it("is a NO-OP on a fixed type — you cannot stage an approve or unstage a request-change", () => {
    // Flagging approve staged does nothing observable: it stays blue.
    const a = stageItem(draft, "a", true);
    expect(itemLane(a[1] as CollationItem)).toBe("blue");
    const r = stageItem(draft, "r", false);
    expect(itemLane(r[2] as CollationItem)).toBe("ink");
  });

  it("is a no-op on an unknown id (never a wipe)", () => {
    expect(stageItem(draft, "nope", true)).toEqual(draft);
  });

  it("does not mutate the input draft", () => {
    const before = JSON.stringify(draft);
    stageItem(draft, "c", true);
    expect(JSON.stringify(draft)).toBe(before);
  });
});

describe("laneCounts / publishReviewLabel — the chrome indicators", () => {
  it("counts ink vs blue over a mixed draft", () => {
    const draft: CollationDraft = [
      item("r", "request-change"),
      item("a", "approve"),
      item("c", "comment", true),
      item("q", "question"),
    ];
    expect(laneCounts(draft)).toEqual({ ink: 2, blue: 2 });
  });

  it("an approve-only draft is all private (zero ink)", () => {
    expect(laneCounts([item("a", "approve"), item("b", "approve")])).toEqual({ ink: 0, blue: 2 });
  });

  it("labels the roll-up outcomes tersely", () => {
    expect(publishReviewLabel("request-changes")).toBe("Request changes");
    expect(publishReviewLabel("comments")).toBe("Comments");
    expect(publishReviewLabel(null)).toBe("Nothing to publish");
  });
});
