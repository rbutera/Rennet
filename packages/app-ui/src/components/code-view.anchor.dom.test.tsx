// @vitest-environment happy-dom
//
// CodeView row identity for the conversation rail (issue #356). The rail queries the
// exposed diff scroll container by `data-anchor-key`; these proofs mount a REAL windowed
// registry and assert the identity is queryable exactly where it must be: a rendered
// line's row is found by its `lineAnchorKey`, an off-window line's key finds nothing (the
// honest stacked fallback), and the chunk container carries its chunk key.
import { describe, expect, it } from "vitest";
import { chunkAnchorKey, lineAnchorKey } from "../canvas/conversation";
import { fireEvent, mount } from "../test/dom";
import { CodeView } from "./code-view";

const PATH = "src/big.ts";

// A long pure-addition hunk: content row i carries additions line i (verified against the
// registrar), so `lineAnchorKey(PATH, "additions", i)` is exactly the key row i stamps.
function bigDiff(lines: number): string {
  const rows = [`@@ -1,${lines} +1,${lines} @@`];
  for (let i = 1; i <= lines; i += 1) rows.push(`+  const value${i} = ${i};`);
  return rows.join("\n");
}

describe("CodeView — queryable anchor identity for the rail (#356)", () => {
  it("exposes the .code-view-scroll container through scrollContainerRef", () => {
    const diffRef: { current: HTMLElement | null } = { current: null };
    mount(
      <CodeView
        path={PATH}
        diff={bigDiff(400)}
        rowHeight={18}
        viewportHeight={480}
        scrollContainerRef={diffRef}
      />,
    );
    expect(diffRef.current).not.toBeNull();
    expect(diffRef.current?.classList.contains("code-view-scroll")).toBe(true);
  });

  it("finds a rendered line's row by its lineAnchorKey, and nothing for an off-window line", () => {
    const diffRef: { current: HTMLElement | null } = { current: null };
    const { container } = mount(
      <CodeView
        path={PATH}
        diff={bigDiff(400)}
        rowHeight={18}
        viewportHeight={480}
        scrollContainerRef={diffRef}
      />,
    );
    const ref = diffRef.current;
    if (!ref) throw new Error("scroll container was not exposed");

    // A line rendered in the initial (top) window is discoverable by its anchor key, and
    // the located element is exactly that content row.
    const visibleKey = lineAnchorKey(PATH, "additions", 2);
    const hits = ref.querySelectorAll(`[data-anchor-key="${visibleKey}"]`);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.getAttribute("data-raw-index")).toBe("2");

    // A line far below the window is not rendered at all, so its key resolves to nothing —
    // the rail's honest stacked fallback, never a fabricated position.
    const deepKey = lineAnchorKey(PATH, "additions", 300);
    expect(ref.querySelector(`[data-anchor-key="${deepKey}"]`)).toBeNull();
    expect(container.querySelector('[data-raw-index="300"]')).toBeNull();

    // Scrolling brings the deep line into the window, where its key now resolves.
    const scrollEl = container.querySelector<HTMLElement>(".code-view-scroll");
    if (!scrollEl) throw new Error("scroll container did not mount");
    fireEvent.scroll(scrollEl, { target: { scrollTop: 300 * 18 - 100 } });
    expect(ref.querySelector(`[data-anchor-key="${deepKey}"]`)).not.toBeNull();
  });

  it("stamps the chunk anchor key on the chunk container", () => {
    const diffRef: { current: HTMLElement | null } = { current: null };
    mount(
      <CodeView
        path={PATH}
        diff={bigDiff(20)}
        rowHeight={18}
        viewportHeight={480}
        scrollContainerRef={diffRef}
      />,
    );
    const ref = diffRef.current;
    if (!ref) throw new Error("scroll container was not exposed");
    const chunk = ref.querySelector(`[data-anchor-key="${chunkAnchorKey(PATH)}"]`);
    expect(chunk).not.toBeNull();
    // The chunk key rides its own element, distinct from every line row's key.
    expect(chunk?.classList.contains("code-view-row")).toBe(false);
  });
});
