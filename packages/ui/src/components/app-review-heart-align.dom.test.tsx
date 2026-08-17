// @vitest-environment happy-dom
//
// The review-heart shape end to end (issue #356): a REAL windowed CodeView as the diff
// column, sharing one diff ref with a sibling ConversationMargin. This is the app-level
// proof the component-only alignment test could not give — the rail aligns against rows
// the real registry stamped, an off-window anchor stacks because its row genuinely is not
// in the DOM, live scrolling re-measures across the windowed lifecycle, and thread growth
// never reflows the diff column. happy-dom reports zero-size rects, so the geometry is
// supplied explicitly; row PRESENCE (the windowing decision) is the real CodeView's.
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lineAnchorKey, openThread } from "../canvas/conversation";
import { act, cleanup, fireEvent, mount } from "../test/dom";
import { CodeView } from "./code-view";
import { ConversationMargin } from "./conversation-cluster";

const PATH = "src/big.ts";

// Content row i carries additions line i (verified against the registrar).
function bigDiff(lines: number): string {
  const rows = [`@@ -1,${lines} +1,${lines} @@`];
  for (let i = 1; i <= lines; i += 1) rows.push(`+  const value${i} = ${i};`);
  return rows.join("\n");
}

const VISIBLE_KEY = lineAnchorKey(PATH, "additions", 2); // rendered in the top window
const OFF_KEY = lineAnchorKey(PATH, "additions", 300); // far below the top window

function rect(top: number): DOMRect {
  return {
    bottom: top + 18,
    height: 18,
    left: 0,
    right: 100,
    top,
    width: 100,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

/** happy-dom rects are all zero; feed the rail real geometry keyed by anchor key. */
function mockGeometry(
  rowTops: Readonly<Record<string, number>>,
  panelTops: Readonly<Record<string, number>>,
): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const key = this.getAttribute("data-anchor-key");
    if (this.classList.contains("conversation-margin")) return rect(100);
    if (key && this.classList.contains("code-view-row")) return rect(rowTops[key] ?? 0);
    if (key && this.classList.contains("conversation-cluster")) return rect(panelTops[key] ?? 0);
    return rect(0);
  });
}

function ReviewHeart({
  threads,
  scrollTop = 0,
}: {
  threads: Parameters<typeof ConversationMargin>[0]["threads"];
  scrollTop?: number;
}) {
  const diffRef = useRef<HTMLElement | null>(null);
  return (
    <div className="review-heart-split">
      <div className="diff-column">
        <CodeView
          path={PATH}
          diff={bigDiff(400)}
          rowHeight={18}
          viewportHeight={480}
          scrollTop={scrollTop}
          scrollContainerRef={diffRef}
        />
      </div>
      <ConversationMargin threads={threads} diffRef={diffRef} />
    </div>
  );
}

describe("Review heart — the aligned margin over a real CodeView (#356)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("aligns an on-window line-anchored panel and stacks an off-window one", () => {
    mockGeometry({ [VISIBLE_KEY]: 160, [OFF_KEY]: 999 }, { [VISIBLE_KEY]: 100, [OFF_KEY]: 220 });
    const { container } = mount(
      <ReviewHeart
        threads={[
          openThread("t-visible", { kind: "line", label: "L2", key: VISIBLE_KEY }),
          openThread("t-off", { kind: "line", label: "L300", key: OFF_KEY }),
        ]}
      />,
    );

    const visible = container.querySelector<HTMLElement>(
      `.conversation-cluster[data-anchor-key="${VISIBLE_KEY}"]`,
    );
    const off = container.querySelector<HTMLElement>(
      `.conversation-cluster[data-anchor-key="${OFF_KEY}"]`,
    );
    // The visible panel is offset from ITS OWN natural top (160 - 100), applied as a
    // transform, never the row's absolute position.
    expect(visible?.getAttribute("data-align-offset")).toBe("60");
    expect(visible?.getAttribute("style") ?? "").toContain("translateY(60px)");
    // The off-window panel has no row in the DOM, so it stacks — no synthetic offset.
    expect(off?.getAttribute("data-align-offset")).toBeNull();
    expect(off?.getAttribute("style") ?? "").not.toContain("translateY");
  });

  it("re-measures on a live diff scroll: the anchor leaving the window drops its panel to stacked", () => {
    mockGeometry({ [VISIBLE_KEY]: 160, [OFF_KEY]: 640 }, { [VISIBLE_KEY]: 100, [OFF_KEY]: 220 });
    const { container } = mount(
      <ReviewHeart
        threads={[
          openThread("t-visible", { kind: "line", label: "L2", key: VISIBLE_KEY }),
          openThread("t-off", { kind: "line", label: "L300", key: OFF_KEY }),
        ]}
      />,
    );
    const visible = () =>
      container.querySelector<HTMLElement>(
        `.conversation-cluster[data-anchor-key="${VISIBLE_KEY}"]`,
      );
    const off = () =>
      container.querySelector<HTMLElement>(`.conversation-cluster[data-anchor-key="${OFF_KEY}"]`);
    expect(visible()?.getAttribute("data-align-offset")).toBe("60");
    expect(off()?.getAttribute("data-align-offset")).toBeNull();

    // Scroll the windowed diff so row 2 recycles out and row 300 comes in.
    const scrollEl = container.querySelector<HTMLElement>(".code-view-scroll");
    if (!scrollEl) throw new Error("scroll container did not mount");
    fireEvent.scroll(scrollEl, { target: { scrollTop: 300 * 18 - 200 } });
    // Re-measure against the now-updated window (a resize is one of the rail's triggers).
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    // The formerly-aligned panel drops to stacked (its row left the window); the formerly
    // off-window panel now aligns from its own natural top (640 - 220).
    expect(visible()?.getAttribute("data-align-offset")).toBeNull();
    expect(off()?.getAttribute("data-align-offset")).toBe("420");
  });

  it("thread growth in the margin never changes the diff column's node positions (no reflow)", () => {
    mockGeometry({ [VISIBLE_KEY]: 160 }, { [VISIBLE_KEY]: 100 });
    const bare = mount(<ReviewHeart threads={[]} />);
    const baseline =
      bare.container.querySelector(".diff-column")?.querySelectorAll("*").length ?? -1;
    expect(baseline).toBeGreaterThan(0);
    cleanup();

    const withThreads = mount(
      <ReviewHeart
        threads={[openThread("t-visible", { kind: "line", label: "L2", key: VISIBLE_KEY })]}
      />,
    );
    expect(withThreads.container.querySelectorAll(".conversation-cluster")).toHaveLength(1);
    // The diff column's DOM is a function of the changeset alone — adding a thread panel to
    // the sibling margin leaves its node count untouched.
    expect(withThreads.container.querySelector(".diff-column")?.querySelectorAll("*").length).toBe(
      baseline,
    );
  });
});
