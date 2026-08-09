// @vitest-environment happy-dom
//
// The COLLATION DRAFT CANVAS (issue #101; ruling R40). Mounted-DOM interaction
// tests that OBSERVE what each edit affordance emits — the red-provable proof that
// reword / retype / reorder / merge / split / withdraw / sign are WIRED to the pure
// model, not just rendered. A control wired to the wrong handler (or to nothing)
// passes an SSR presence check and fails here.
import { describe, expect, it } from "vitest";
import { type CollationDraft, collationItems, collationPayload } from "../canvas/collation";
import { destinationVariant } from "../canvas/destination";
import { deriveReviewEvent, reviewComments } from "../canvas/publish";
import { fireEvent, mount, within } from "../test/dom";
import { CollationDraftCanvas } from "./collation-draft-canvas";

const variant = destinationVariant("other-pr");

function draftOf(...paths: string[]): CollationDraft {
  return paths.map((path) => ({ id: path, path, type: "comment", raw: `note ${path}` }));
}

/** Mount with a captured onChange; returns the latest draft the canvas emitted. */
function mountCanvas(draft: CollationDraft) {
  const changes: CollationDraft[] = [];
  const signs: number[] = [];
  const result = mount(
    <CollationDraftCanvas
      draft={draft}
      variant={variant}
      onChange={(next) => changes.push(next)}
      onSign={() => signs.push(1)}
    />,
  );
  return {
    ...result,
    last: () => changes.at(-1),
    changeCount: () => changes.length,
    signCount: () => signs.length,
  };
}

function itemAt(container: HTMLElement, index: number): HTMLElement {
  const items = container.querySelectorAll<HTMLElement>(".collation-item");
  const item = items[index];
  if (!item) throw new Error(`no collation item at index ${index}`);
  return item;
}

describe("empty state", () => {
  it("names the empty forming DRAFT (not the paper) and disables sign", () => {
    const { container } = mountCanvas([]);
    expect(container.textContent).toContain("The draft is empty");
    const sign = container.querySelector<HTMLButtonElement>(".collation-sign");
    // Sign is disabled with nothing collated — you cannot freeze an empty draft.
    expect(sign?.disabled).toBe(true);
  });
});

describe("see everything together", () => {
  it("renders every collated disposition as one ordered list", () => {
    const { container } = mountCanvas(draftOf("src/a.ts", "src/b.ts", "src/c.ts"));
    const items = container.querySelectorAll(".collation-item");
    expect(items).toHaveLength(3);
    // Ordinals reflect draft order — the first time the whole account is one object.
    expect(container.textContent).toContain("src/a.ts");
    expect(container.textContent).toContain("src/c.ts");
  });
});

describe("reword — the body textarea edits the targeted item's raw", () => {
  it("typing a body emits a draft with that item reworded, others untouched", () => {
    const draft = draftOf("src/a.ts", "src/b.ts");
    const { container, last } = mountCanvas(draft);
    const body = within(itemAt(container, 1)).getByLabelText("Body for item 2");
    fireEvent.change(body, { target: { value: "reworded b" } });
    const next = last();
    expect(next?.find((item) => item.id === "src/b.ts")?.raw).toBe("reworded b");
    // Untargeted item unchanged — a handler wired to the wrong id reddens this.
    expect(next?.find((item) => item.id === "src/a.ts")?.raw).toBe("note src/a.ts");
  });
});

describe("retype — the per-line verdict buttons change the targeted item's disposition (issue #109)", () => {
  it("clicking a verdict button emits a draft with that item retyped", () => {
    const draft = draftOf("src/a.ts");
    const { container, last } = mountCanvas(draft);
    const request = within(itemAt(container, 0)).getByRole("button", { name: "Request change" });
    fireEvent.click(request);
    expect(last()?.[0]?.type).toBe("request-change");
  });

  it("the current verdict button reads as pressed (aria-pressed), others do not", () => {
    // item starts as a comment (draftOf uses `comment`), so Comment is pressed.
    const { container } = mountCanvas(draftOf("src/a.ts"));
    const comment = within(itemAt(container, 0)).getByRole("button", { name: "Comment" });
    const approve = within(itemAt(container, 0)).getByRole("button", { name: "Approve" });
    expect(comment.getAttribute("aria-pressed")).toBe("true");
    expect(approve.getAttribute("aria-pressed")).toBe("false");
  });

  it("setting a line to request-change flips the whole review's DERIVED verdict to REQUEST_CHANGES", () => {
    // Every line is a comment ⇒ the review derives COMMENT. Set ONE line to
    // request-change and the whole review's verdict escalates — the roll-up the
    // sign wire posts (issue #109: any request-change block ⇒ the whole PR review
    // requests changes). This is the real round-trip: the per-line control feeds
    // collate → draft → the signed verdict, not a cosmetic toggle.
    const draft = draftOf("src/a.ts", "src/b.ts");
    expect(deriveReviewEvent(reviewComments(draft))).toBe("COMMENT");
    const { container, last } = mountCanvas(draft);
    fireEvent.click(within(itemAt(container, 1)).getByRole("button", { name: "Request change" }));
    const next = last();
    if (!next) throw new Error("no draft emitted");
    expect(deriveReviewEvent(reviewComments(next))).toBe("REQUEST_CHANGES");
    // And the live readout on the canvas shows the same escalated verdict.
    const rerendered = mountCanvas(next);
    expect(
      rerendered.container.querySelector(".collation-verdict")?.getAttribute("data-verdict"),
    ).toBe("REQUEST_CHANGES");
  });
});

describe("reorder — move up/down swaps order and is disabled at the boundary", () => {
  it("move-down on the first item swaps it with the second", () => {
    const draft = draftOf("src/a.ts", "src/b.ts");
    const { container, last } = mountCanvas(draft);
    const down = within(itemAt(container, 0)).getByLabelText("Move item 1 down");
    fireEvent.click(down);
    // Reorder is a real output-order change: a becomes second.
    expect(last()?.map((item) => item.id)).toEqual(["src/b.ts", "src/a.ts"]);
  });

  it("move-up is disabled on the first item; move-down on the last", () => {
    const { container } = mountCanvas(draftOf("src/a.ts", "src/b.ts"));
    const firstUp = within(itemAt(container, 0)).getByLabelText<HTMLButtonElement>(
      "Move item 1 up",
    );
    const lastDown = within(itemAt(container, 1)).getByLabelText<HTMLButtonElement>(
      "Move item 2 down",
    );
    expect(firstUp.disabled).toBe(true);
    expect(lastDown.disabled).toBe(true);
  });
});

describe("merge — Merge ↓ collapses an item with the one below it", () => {
  it("merges item 1 into… actually the next INTO item 1, joining bodies, dropping the source", () => {
    const draft: CollationDraft = [
      { id: "src/a.ts", path: "src/a.ts", type: "comment", raw: "first" },
      { id: "src/b.ts", path: "src/b.ts", type: "comment", raw: "second" },
    ];
    const { container, last } = mountCanvas(draft);
    fireEvent.click(within(itemAt(container, 0)).getByLabelText("Merge item 1 with the next"));
    const next = last();
    // One item remains (the source below was removed); bodies joined, target first.
    expect(next).toHaveLength(1);
    expect(next?.[0]?.id).toBe("src/a.ts");
    expect(next?.[0]?.raw).toBe("first\nsecond");
  });

  it("Merge ↓ is disabled on the last item (nothing below to merge)", () => {
    const { container } = mountCanvas(draftOf("src/a.ts", "src/b.ts"));
    const lastMerge = within(itemAt(container, 1)).getByLabelText<HTMLButtonElement>(
      "Merge item 2 with the next",
    );
    expect(lastMerge.disabled).toBe(true);
  });
});

describe("split — Split inserts an empty sibling right after, sharing the path", () => {
  it("splitting item 1 emits three items with a blank sibling at index 1", () => {
    const draft = draftOf("src/a.ts", "src/b.ts");
    const { container, last } = mountCanvas(draft);
    fireEvent.click(within(itemAt(container, 0)).getByLabelText("Split item 1 into two"));
    const next = last();
    expect(next).toHaveLength(3);
    // Sibling inserted immediately after the original (index 1), not appended.
    expect(next?.[1]?.path).toBe("src/a.ts");
    expect(next?.[1]?.raw).toBe("");
    expect(next?.[1]?.id).not.toBe("src/a.ts");
  });
});

describe("withdraw — removes exactly the targeted item (unstage, zero residue)", () => {
  it("withdrawing item 1 emits a draft without it", () => {
    const draft = draftOf("src/a.ts", "src/b.ts");
    const { container, last } = mountCanvas(draft);
    fireEvent.click(within(itemAt(container, 0)).getByLabelText("Withdraw item 1"));
    expect(last()?.some((item) => item.id === "src/a.ts")).toBe(false);
    expect(last()).toHaveLength(1);
  });
});

describe("sign — freezes the glass draft into the paper (the phase transition)", () => {
  it("Sign the draft fires onSign; it is disabled when empty", () => {
    const { container, signCount } = mountCanvas(draftOf("src/a.ts"));
    const sign = container.querySelector<HTMLButtonElement>(".collation-sign");
    if (!sign) throw new Error("sign control missing");
    expect(sign.disabled).toBe(false);
    fireEvent.click(sign);
    // The canvas does not sign itself — it hands off to the paper. onSign is the
    // transition; a button wired to onChange or nothing reddens this.
    expect(signCount()).toBe(1);
  });
});

describe("payload reflects draft order after a reorder (order is what leaves)", () => {
  it("moving an item changes the ordered outbound payload", () => {
    const draft = draftOf("src/a.ts", "src/b.ts");
    const { container, last } = mountCanvas(draft);
    fireEvent.click(within(itemAt(container, 0)).getByLabelText("Move item 1 down"));
    const reordered = last();
    if (!reordered) throw new Error("no draft emitted");
    expect(collationPayload(reordered)).not.toBe(collationPayload(draft));
    expect(collationItems(reordered).map((item) => item.path)).toEqual(["src/b.ts", "src/a.ts"]);
  });
});
