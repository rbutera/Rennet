// @vitest-environment happy-dom
//
// C07 Fix #3 (fidelity polish): during an active stream, only NEWLY-arrived words animate in.
// Pre-fix each delta re-applied `.animate-word-in` + `opacity-0` to every word with an
// absolute-index delay, so already-revealed words restarted and tail words sat invisible
// waiting out a growing delay. These pin the settled words as settled and the new word as
// the only one animating.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, mount } from "../test/dom";
import { StreamingProse } from "./streaming-prose";

afterEach(cleanup);

const wordSpans = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>("p > span > span"));
const byText = (container: HTMLElement, text: string) =>
  wordSpans(container).find((s) => s.textContent === text);

describe("StreamingProse animates only newly-arrived words (Fix #3)", () => {
  it("does not restart already-revealed words when a delta appends new ones", () => {
    const { container, rerender } = mount(<StreamingProse paragraphs={["one two"]} />);
    // First render: the whole batch is arriving → both words animate.
    expect(container.querySelectorAll(".animate-word-in").length).toBe(2);

    // A delta appends "three": the first two are now settled (no restart), only "three" animates.
    rerender(<StreamingProse paragraphs={["one two three"]} />);
    expect(byText(container, "one")?.className).not.toContain("animate-word-in");
    expect(byText(container, "one")?.className).not.toContain("opacity-0");
    expect(byText(container, "two")?.className).not.toContain("animate-word-in");
    expect(byText(container, "three")?.className).toContain("animate-word-in");
    expect(container.querySelectorAll(".animate-word-in").length).toBe(1);
  });

  it("renders records (animate=false) with no animation at all", () => {
    const { container } = mount(<StreamingProse animate={false} paragraphs={["a b c"]} />);
    expect(container.querySelectorAll(".animate-word-in").length).toBe(0);
    expect(container.textContent).toContain("a b c");
  });
});
