// @vitest-environment happy-dom
//
// The review-heart shape end to end (issue #356): a REAL windowed CodeView as the diff
// column, sharing one diff element with a sibling ConversationMargin. This is the app-level
// proof the component-only alignment test could not give — the rail aligns against rows the
// real registry stamped, an off-window anchor stacks because its row genuinely is not in the
// DOM, live scrolling re-measures across the windowed lifecycle, a CodeView remount re-subscribes
// against the LIVE element, same-anchor threads stack instead of overlapping, and thread growth
// never reflows the diff column. happy-dom reports zero-size rects, so the geometry is supplied
// explicitly; row PRESENCE (the windowing decision) is the real CodeView's.
import { useMemo, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chunkAnchorKey, lineAnchorKey, openThread } from "../canvas/conversation";
import { act, cleanup, fireEvent, mount, waitFor } from "../test/dom";
import { CodeView } from "./code-view";
import { ConversationMargin } from "./conversation-cluster";

const PATH = "src/big.ts";
const PATH_B = "src/other.ts";

// Content row i carries additions line i (verified against the registrar).
function bigDiff(lines: number): string {
  const rows = [`@@ -1,${lines} +1,${lines} @@`];
  for (let i = 1; i <= lines; i += 1) rows.push(`+  const value${i} = ${i};`);
  return rows.join("\n");
}

const VISIBLE_KEY = lineAnchorKey(PATH, "additions", 2); // rendered in the top window
const OFF_KEY = lineAnchorKey(PATH, "additions", 300); // far below the top window
const KEY_B = lineAnchorKey(PATH_B, "additions", 2); // line 2 of the OTHER file
const CHUNK_KEY = chunkAnchorKey(PATH); // the whole-file anchor on the top spacer

// Same-anchor sibling panels are stacked apart by this much in the mock, so a design that
// collapses them onto one coordinate (the overlap bug) is distinguishable from one that
// keeps them flowing beneath each other.
const SAME_KEY_STEP = 200;

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

/**
 * happy-dom rects are all zero; feed the rail real geometry keyed by anchor key. A keyed
 * row OR the chunk spacer resolves by `rowTops`; a thread panel resolves by `panelTops`,
 * offset by its position AMONG same-key siblings so two threads on one anchor get distinct
 * natural tops (the input the overlap fix must separate).
 */
function mockGeometry(
  rowTops: Readonly<Record<string, number>>,
  panelTops: Readonly<Record<string, number>>,
): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const key = this.getAttribute("data-anchor-key");
    if (this.classList.contains("conversation-margin")) return rect(100);
    if (key && this.classList.contains("conversation-cluster")) {
      const siblings = [
        ...(this.parentElement?.querySelectorAll(
          `.conversation-cluster[data-anchor-key="${key}"]`,
        ) ?? []),
      ];
      const idx = Math.max(0, siblings.indexOf(this));
      return rect((panelTops[key] ?? 0) + idx * SAME_KEY_STEP);
    }
    if (key) return rect(rowTops[key] ?? 0); // a diff row OR the chunk spacer
    return rect(0);
  });
}

function ReviewHeart({
  threads,
  scrollTop = 0,
  path = PATH,
}: {
  threads: Parameters<typeof ConversationMargin>[0]["threads"];
  scrollTop?: number;
  path?: string;
}) {
  // The element identity flows through STATE via a callback ref (the app's shape), so the
  // memoised RefObject changes identity when CodeView remounts — the trigger the rail's
  // alignment effect needs to re-subscribe against the live element.
  const [diffEl, setDiffEl] = useState<HTMLElement | null>(null);
  const diffRef = useMemo(() => ({ current: diffEl }), [diffEl]);
  return (
    <div className="review-heart-split">
      <div className="diff-column">
        {/* `key={path}` forces a genuine unmount/remount when the shown file changes. */}
        <CodeView
          key={path}
          path={path}
          diff={bigDiff(400)}
          rowHeight={18}
          viewportHeight={480}
          scrollTop={scrollTop}
          scrollContainerRef={setDiffEl}
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

  it("re-measures on a live diff scroll ALONE (no resize): the anchor leaving the window stacks", async () => {
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

    // Scroll the windowed diff so row 2 recycles out and row 300 comes in — and do NOT
    // dispatch a resize. The rail must re-measure off the scroll alone, on the frame AFTER
    // the windowed rows commit (the earlier test masked the stale-read bug with a resize).
    const scrollEl = container.querySelector<HTMLElement>(".code-view-scroll");
    if (!scrollEl) throw new Error("scroll container did not mount");
    act(() => {
      fireEvent.scroll(scrollEl, { target: { scrollTop: 300 * 18 - 200 } });
    });

    // The formerly-aligned panel drops to stacked (its row left the window); the formerly
    // off-window panel now aligns from its own natural top (640 - 220).
    await waitFor(() => {
      expect(visible()?.getAttribute("data-align-offset")).toBeNull();
      expect(off()?.getAttribute("data-align-offset")).toBe("420");
    });
  });

  it("re-subscribes against the live element when CodeView remounts (a zoom into another file)", async () => {
    mockGeometry({ [VISIBLE_KEY]: 160, [KEY_B]: 160 }, { [VISIBLE_KEY]: 100, [KEY_B]: 100 });
    const threads = [
      openThread("t-a", { kind: "line", label: "L2", key: VISIBLE_KEY }),
      openThread("t-b", { kind: "line", label: "L2b", key: KEY_B }),
    ];
    const { container, rerender } = mount(<ReviewHeart threads={threads} path={PATH} />);
    const aPanel = () =>
      container.querySelector<HTMLElement>(
        `.conversation-cluster[data-anchor-key="${VISIBLE_KEY}"]`,
      );
    const bPanel = () =>
      container.querySelector<HTMLElement>(`.conversation-cluster[data-anchor-key="${KEY_B}"]`);
    // File A is mounted: A's row is on-window (aligned), B's file is not shown (stacked).
    expect(aPanel()?.getAttribute("data-align-offset")).toBe("60");
    expect(bPanel()?.getAttribute("data-align-offset")).toBeNull();

    // Remount with file B (a different `key` unmounts A's CodeView and mounts B's). If the
    // rail held the DETACHED file-A element, A's stale "60" would survive; instead A must
    // drop to stacked (its row is gone) and B must newly align — the re-subscription proof.
    rerender(<ReviewHeart threads={threads} path={PATH_B} />);
    await waitFor(() => {
      expect(aPanel()?.getAttribute("data-align-offset")).toBeNull();
      expect(bPanel()?.getAttribute("data-align-offset")).toBe("60");
    });
  });

  it("stacks a chunk-anchored panel once its top scrolls off, never hides it offscreen", async () => {
    // The chunk key rides the top spacer; scrolled past, keeping it there would translate the
    // panel by a large negative offset (hidden). At the top it aligns; scrolled, it must STACK.
    mockGeometry({ [CHUNK_KEY]: 120 }, { [CHUNK_KEY]: 100 });
    const { container } = mount(
      <ReviewHeart
        threads={[openThread("t-chunk", { kind: "chunk", label: PATH, key: CHUNK_KEY })]}
      />,
    );
    const chunk = () =>
      container.querySelector<HTMLElement>(`.conversation-cluster[data-anchor-key="${CHUNK_KEY}"]`);
    // At the top: the spacer carries the chunk key, so the panel aligns (120 - 100).
    expect(chunk()?.getAttribute("data-align-offset")).toBe("20");

    const scrollEl = container.querySelector<HTMLElement>(".code-view-scroll");
    if (!scrollEl) throw new Error("scroll container did not mount");
    act(() => {
      fireEvent.scroll(scrollEl, { target: { scrollTop: 300 * 18 } });
    });
    // Past the top the spacer drops the key, so the chunk panel STACKS (no transform) —
    // it stays visible in document order, never shoved offscreen by a negative translate.
    await waitFor(() => {
      expect(chunk()?.getAttribute("data-align-offset")).toBeNull();
      expect(chunk()?.getAttribute("style") ?? "").not.toContain("translateY");
    });
  });

  it("gives two threads on the SAME anchor one shared offset so they flow beneath, not overlap", () => {
    // Both threads anchor to L2. Each panel has a distinct natural top (100, 300). The bug gave
    // each `row - ownNaturalTop`, landing BOTH at row-top 160 (exact overlap). The fix aligns
    // the first and rides the rest on that SAME offset, so they keep their natural gap beneath it.
    mockGeometry({ [VISIBLE_KEY]: 160 }, { [VISIBLE_KEY]: 100 });
    const { container } = mount(
      <ReviewHeart
        threads={[
          openThread("t-1", { kind: "line", label: "L2", key: VISIBLE_KEY }),
          openThread("t-2", { kind: "line", label: "L2", key: VISIBLE_KEY }),
        ]}
      />,
    );
    const panels = container.querySelectorAll<HTMLElement>(
      `.conversation-cluster[data-anchor-key="${VISIBLE_KEY}"]`,
    );
    expect(panels).toHaveLength(2);
    const first = panels[0]?.getAttribute("data-align-offset");
    const second = panels[1]?.getAttribute("data-align-offset");
    // The shared group offset aligns the first panel (160 - 100 = 60); the second rides the
    // SAME offset, so at natural top 300 it sits at 360 — beneath the first, not on top of it.
    expect(first).toBe("60");
    expect(second).toBe("60");
  });

  it("thread growth in the margin never changes the diff column's node positions (no reflow)", () => {
    mockGeometry({ [VISIBLE_KEY]: 160 }, { [VISIBLE_KEY]: 100 });
    const bare = mount(<ReviewHeart threads={[]} />);
    const diffColumn = () => bare.container.querySelector(".diff-column");
    const rowTops = () =>
      [...(diffColumn()?.querySelectorAll<HTMLElement>("[data-anchor-key]") ?? [])].map(
        (el) => el.getBoundingClientRect().top,
      );
    const baselineCount = diffColumn()?.querySelectorAll("*").length ?? -1;
    const baselineTops = rowTops();
    expect(baselineCount).toBeGreaterThan(0);
    expect(baselineTops.length).toBeGreaterThan(0);
    cleanup();

    const withThreads = mount(
      <ReviewHeart
        threads={[openThread("t-visible", { kind: "line", label: "L2", key: VISIBLE_KEY })]}
      />,
    );
    const grownColumn = withThreads.container.querySelector(".diff-column");
    const grownTops = [
      ...(grownColumn?.querySelectorAll<HTMLElement>("[data-anchor-key]") ?? []),
    ].map((el) => el.getBoundingClientRect().top);
    expect(withThreads.container.querySelectorAll(".conversation-cluster")).toHaveLength(1);
    // The aligned panel positions itself with a TRANSFORM only — never a margin/top shift that
    // would push the diff. So the diff column's node count AND every diff row's top are
    // unchanged when a thread panel appears in the sibling margin.
    const aligned = withThreads.container.querySelector<HTMLElement>(
      `.conversation-cluster[data-anchor-key="${VISIBLE_KEY}"]`,
    );
    expect(aligned?.getAttribute("style") ?? "").toContain("translateY");
    expect(aligned?.getAttribute("style") ?? "").not.toMatch(/margin|(^|\s|;)top:/);
    expect(grownColumn?.querySelectorAll("*").length).toBe(baselineCount);
    expect(grownTops).toEqual(baselineTops);
  });
});
