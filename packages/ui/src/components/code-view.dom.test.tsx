// @vitest-environment happy-dom
//
// Mounted-interaction coverage for CodeView — the proof the #53 DOM harness is
// real. Every assertion here is IMPOSSIBLE under the node/SSR harness the rest of
// the suite uses: they mount a live tree, drive a real DOM event / let an effect
// resolve, and assert React re-rendered. This is the exact class of test whose
// absence let the #11 Canvas UI ship four interaction bugs past green SSR tests
// (frozen CodeView scroll among them). The pattern established here is what #17,
// #22, #35, #36 and #37 mount through.
import { describe, expect, it } from "vitest";
import type { Mark } from "../canvas/registrar";
import { fireEvent, mount, waitFor } from "../test/dom";
import { CodeView } from "./code-view";

// A long diff so the window has rows above and below the viewport to reveal.
// Row 0 is the `@@` header; content rows are 1…lines.
function bigDiff(lines: number): string {
  const rows = [`@@ -1,${lines} +1,${lines} @@`];
  for (let index = 1; index <= lines; index += 1) rows.push(`+  const value${index} = ${index};`);
  return rows.join("\n");
}

// A single real hunk so a mark's anchor resolves onto concrete rows (occurrence "H").
const ONE_HUNK = [
  "@@ -10,3 +10,4 @@",
  "   const a = 1;",
  "-  const b = 2;",
  "+  const b = 3;",
  "+  const c = 4;",
  "   return a;",
].join("\n");

describe("CodeView — mounted scroll interaction (the #11 frozen-window bug)", () => {
  it("re-windows on a real scroll event: new rows are revealed, the top recycles out", () => {
    const { container } = mount(
      <CodeView path="src/big.ts" diff={bigDiff(400)} rowHeight={18} viewportHeight={480} />,
    );
    const scrollEl = container.querySelector<HTMLElement>(".code-view-scroll");
    if (!scrollEl) throw new Error("scroll container did not mount");

    // Before any scroll: the window is pinned at the top. Row 0 is painted, and a
    // deep row (200) is nowhere in the DOM.
    expect(scrollEl.getAttribute("data-window-start")).toBe("0");
    expect(container.querySelector('[data-raw-index="0"]')).not.toBeNull();
    expect(container.querySelector('[data-raw-index="200"]')).toBeNull();

    // Drive a real scroll. The onScroll handler must read scrollTop and advance
    // the internal window state — if it is dropped (the #11 bug), nothing moves.
    fireEvent.scroll(scrollEl, { target: { scrollTop: 3600 } });

    // The window moved: the deep row is now painted and the top row recycled out.
    const movedStart = Number(scrollEl.getAttribute("data-window-start"));
    expect(movedStart).toBeGreaterThan(0);
    expect(container.querySelector('[data-raw-index="200"]')).not.toBeNull();
    expect(container.querySelector('[data-raw-index="0"]')).toBeNull();
  });

  it("starts each test from a clean document (the harness unmounts between tests)", () => {
    // Proves afterEach(cleanup) from the shared harness fired: the previous test's
    // tree is gone before this one mounts. Guards downstream slices against
    // cross-test DOM bleed.
    expect(document.body.querySelector(".code-view")).toBeNull();
  });
});

describe("CodeView — mounted effect resolves (the #59 render-path proof)", () => {
  it("fires onPlacement after mount, reporting the placed mark", async () => {
    const marks: Mark[] = [
      {
        markId: "ann1",
        markKind: "annotation",
        anchor: "rennet:hunk/H#L1-L2@additions",
        body: "new lines",
      },
    ];
    const seen: string[] = [];
    mount(
      <CodeView
        path="foo.ts"
        diff={ONE_HUNK}
        occurrenceIds="H"
        marks={marks}
        viewportHeight={480}
        onPlacement={(placement) => {
          for (const placed of placement.placed) seen.push(placed.mark.markId);
        }}
      />,
    );

    // The placement is delivered by a useEffect, not during SSR — so this can only
    // pass in a mounted environment. If the effect's deps regress and it stops
    // firing, `seen` stays empty and this goes red.
    await waitFor(() => expect(seen).toContain("ann1"));
  });
});
