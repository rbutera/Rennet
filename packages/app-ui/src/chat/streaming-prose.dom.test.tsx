// @vitest-environment happy-dom
//
// C07 Fix #3 (fidelity polish): during an active stream, only NEWLY-arrived words animate in.
// Pre-fix each delta re-applied `.animate-word-in` + `opacity-0` to every word with an
// absolute-index delay, so already-revealed words restarted and tail words sat invisible
// waiting out a growing delay. These pin the settled words as settled and the new word as
// the only one animating.
//
// Perf audit §5 H9 sharpened both halves: a revealed word is no longer an ELEMENT at all
// (it collapses into the paragraph's settled text, which is also how the same prose renders
// as a record), and the `word-in` keyframe no longer lands on an explicit `filter`/`transform`
// that its `forwards` fill would retain forever.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, mount } from "../test/dom";
import { StreamingProse } from "./streaming-prose";

afterEach(cleanup);

/** The words that are ANIMATING right now. A settled word is text, not an element. */
const wordSpans = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>("p > span"));
const wordTexts = (container: HTMLElement) => wordSpans(container).map((s) => s.textContent);

describe("StreamingProse animates only newly-arrived words (Fix #3)", () => {
  it("does not restart already-revealed words when a delta appends new ones", () => {
    const { container, rerender } = mount(<StreamingProse paragraphs={["one two"]} />);
    // First render: the whole batch is arriving → both words animate.
    expect(container.querySelectorAll(".animate-word-in").length).toBe(2);
    expect(wordTexts(container)).toEqual(["one", "two"]);

    // A delta appends "three": the first two are now settled (no restart, and no longer
    // elements), only "three" animates.
    rerender(<StreamingProse paragraphs={["one two three"]} />);
    expect(wordTexts(container)).toEqual(["three"]);
    expect(container.querySelectorAll(".animate-word-in").length).toBe(1);
    // The settled words are still on screen, spelled the same way, in order.
    expect(container.querySelector("p")?.textContent).toBe("one two three");
  });

  it("renders records (animate=false) with no animation at all", () => {
    const { container } = mount(<StreamingProse animate={false} paragraphs={["a b c"]} />);
    expect(container.querySelectorAll(".animate-word-in").length).toBe(0);
    expect(container.textContent).toContain("a b c");
  });

  it("keeps the paragraph split and the per-batch stagger across a multi-paragraph delta", () => {
    const { container, rerender } = mount(<StreamingProse paragraphs={["alpha beta", "gamma"]} />);
    expect(wordTexts(container)).toEqual(["alpha", "beta", "gamma"]);

    rerender(<StreamingProse paragraphs={["alpha beta", "gamma delta"]} />);
    const animating = wordSpans(container);
    // Only the appended word animates, and its delay restarts from the NEW batch (0ms),
    // not from its absolute index (which would strand it invisible for 3 × 22ms).
    expect(animating.map((s) => s.textContent)).toEqual(["delta"]);
    expect(animating[0]?.style.animationDelay).toBe("0ms");
    const paragraphs = Array.from(container.querySelectorAll("p")).map((p) => p.textContent);
    expect(paragraphs).toEqual(["alpha beta", "gamma delta"]);
  });
});

// ── The reveal must not leave a filter behind (perf audit §5 H9) ─────────────────────────
//
// UNPROVEN HERE, deliberately. happy-dom neither runs a CSS animation nor computes its
// fill, and there is no `animationend` to simulate: the fix is that the keyframe's landing
// frame declares nothing a `forwards` fill could retain, so there is no JS state machine to
// drive. This half proves only that a settled word is not an ELEMENT, so it carries no
// animation, no inline delay and no inline filter. The keyframe's own landing frame is
// pinned in `styles-contract.css.test.ts` (the source-level home for exactly this, since
// happy-dom runs no animations). NEITHER proves the browser-level claim — that a real engine
// then drops the compositing layer and the stacking context. That needs a devtools layer
// count on the built app, not a DOM assertion.

describe("a revealed word retains no filter", () => {
  it("leaves no animation class, inline delay or inline filter on a settled word", () => {
    const { container, rerender } = mount(<StreamingProse paragraphs={["one two"]} />);
    // Contrast: while arriving, the words DO carry the animation and an inline delay.
    expect(wordSpans(container).every((s) => s.className.includes("animate-word-in"))).toBe(true);
    expect(wordSpans(container).some((s) => s.style.animationDelay !== "")).toBe(true);

    rerender(<StreamingProse paragraphs={["one two three"]} />);
    // "one"/"two" are text now: nothing in the tree carries their animation or an inline
    // filter, and the only element left with a delay is the arriving word.
    const styled = Array.from(container.querySelectorAll<HTMLElement>("[style]"));
    expect(styled.map((s) => s.textContent)).toEqual(["three"]);
    expect(styled.every((s) => s.style.filter === "")).toBe(true);
    expect(container.querySelectorAll("span").length).toBe(1);
  });
});
