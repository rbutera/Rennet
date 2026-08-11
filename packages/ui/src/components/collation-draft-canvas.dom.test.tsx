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
import { fireEvent, mount, within } from "../test/dom";
import { CollationDraftCanvas, type RefineItemState } from "./collation-draft-canvas";

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

describe("retype — the type select changes the targeted item's disposition", () => {
  it("selecting a type emits a draft with that item retyped", () => {
    const draft = draftOf("src/a.ts");
    const { container, last } = mountCanvas(draft);
    const select = within(itemAt(container, 0)).getByLabelText("Type for item 1");
    fireEvent.change(select, { target: { value: "approve" } });
    expect(last()?.[0]?.type).toBe("approve");
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

describe("refine control (#19) — the comment-refinement loop", () => {
  function mountRefine(draft: CollationDraft, refineStates?: Record<string, RefineItemState>) {
    const changes: CollationDraft[] = [];
    const refines: string[] = [];
    const keeps: string[] = [];
    const alls: number[] = [];
    const result = mount(
      <CollationDraftCanvas
        draft={draft}
        variant={variant}
        onChange={(next) => changes.push(next)}
        onRefine={(item) => refines.push(item.id)}
        onKeepRaw={(item) => keeps.push(item.id)}
        onRefineAll={() => alls.push(1)}
        {...(refineStates ? { refineStates } : {})}
      />,
    );
    return { ...result, changes, refines, keeps, alls };
  }

  it("offers a per-item Refine button that fires onRefine with that item", () => {
    const { container, refines } = mountRefine(draftOf("src/a.ts", "src/b.ts"));
    fireEvent.click(within(itemAt(container, 1)).getByLabelText("Refine item 2"));
    // The button is wired to the SECOND item; a handler bound to the wrong id reddens this.
    expect(refines).toEqual(["src/b.ts"]);
  });

  it("does not offer Refine on an empty note (nothing to clean)", () => {
    const draft: CollationDraft = [{ id: "a", path: "src/a.ts", type: "approve", raw: "" }];
    const { container } = mountRefine(draft);
    expect(within(itemAt(container, 0)).queryByLabelText("Refine item 1")).toBeNull();
  });

  it("renders a landed refinement prominently and Keep-my-original undoes it", () => {
    const draft: CollationDraft = [
      { id: "a", path: "src/a.ts", type: "comment", raw: "messy", refined: "the clean comment" },
    ];
    const { container, keeps } = mountRefine(draft);
    // The refined body is shown; the raw is still the editable textarea (sovereign).
    expect(container.textContent).toContain("the clean comment");
    expect(
      within(itemAt(container, 0)).getByLabelText<HTMLTextAreaElement>("Body for item 1").value,
    ).toBe("messy");
    fireEvent.click(within(itemAt(container, 0)).getByLabelText("Keep original note for item 1"));
    expect(keeps).toEqual(["a"]);
  });

  it("shows the in-flight state and hides the Refine button while refining", () => {
    const { container } = mountRefine(draftOf("src/a.ts"), {
      "src/a.ts": { status: "refining" },
    });
    expect(container.textContent).toContain("Refining");
    expect(within(itemAt(container, 0)).queryByLabelText("Refine item 1")).toBeNull();
  });

  it("states a failed turn honestly (terse chrome + the reason as content) and offers Retry", () => {
    const { container, refines } = mountRefine(draftOf("src/a.ts"), {
      "src/a.ts": { status: "failed", reason: "codex exited 1" },
    });
    // Terse chrome label + the model/system reason (content). The raw textarea stays
    // visible, so "the original posts" holds structurally without a chrome sentence.
    expect(container.textContent).toContain("Refine failed");
    expect(container.textContent).toContain("codex exited 1");
    fireEvent.click(within(itemAt(container, 0)).getByLabelText("Retry refining item 1"));
    expect(refines).toEqual(["src/a.ts"]);
  });

  it("states no-change honestly (the note posts as written)", () => {
    const { container } = mountRefine(draftOf("src/a.ts"), {
      "src/a.ts": { status: "no-change" },
    });
    expect(container.textContent).toContain("Already clear");
  });

  it("Refine-to-post fires onRefineAll, and disables when nothing is refinable", () => {
    const { container, alls } = mountRefine(draftOf("src/a.ts"));
    const all = container.querySelector<HTMLButtonElement>(".collation-refine-all");
    if (!all) throw new Error("refine-all control missing");
    expect(all.disabled).toBe(false);
    fireEvent.click(all);
    expect(alls).toEqual([1]);

    // A draft whose only item is already refined has nothing to bulk-refine.
    const refinedDraft: CollationDraft = [
      { id: "a", path: "src/a.ts", type: "comment", raw: "m", refined: "c" },
    ];
    const { container: c2 } = mountRefine(refinedDraft);
    expect(c2.querySelector<HTMLButtonElement>(".collation-refine-all")?.disabled).toBe(true);
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
