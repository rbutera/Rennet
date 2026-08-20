// @vitest-environment happy-dom
//
// Mounted-interaction coverage for CodeView — the proof the #53 DOM harness is
// real. Every assertion here is IMPOSSIBLE under the node/SSR harness the rest of
// the suite uses: they mount a live tree, drive a real DOM event / let an effect
// resolve, and assert React re-rendered. This is the exact class of test whose
// absence let the #11 Canvas UI ship four interaction bugs past green SSR tests
// (frozen CodeView scroll among them). The pattern established here is what #17,
// #22, #35, #36 and #37 mount through.
import type { RenderedHunkOccurrence } from "@rennet/types";
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

// The single-occurrence mapping for ONE_HUNK (`@@ -10,3 +10,4 @@`): one rendered hunk
// = occurrence "H", with its REAL line range (rows are partitioned by containment).
const OCC_H: RenderedHunkOccurrence[][] = [
  [{ id: "H", oldStart: 10, oldLines: 3, newStart: 10, newLines: 4 }],
];

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

  it("follows a focusAnchor beyond the initial viewport into view (the coverage-chip jump)", async () => {
    // A 400-row hunk; the initial window is pinned at the top (rows ~0-30).
    const { container } = mount(
      <CodeView
        path="src/big.ts"
        diff={bigDiff(400)}
        // Occurrence "H" spans the whole 400-addition hunk (new lines 1..400).
        hunkOccurrences={[[{ id: "H", oldStart: 1, oldLines: 400, newStart: 1, newLines: 400 }]]}
        rowHeight={18}
        viewportHeight={480}
        // A jump target deep in the hunk (new-file lines 200-201 → rows ~200).
        focusAnchor="rennet:hunk/H#L200-L201@additions"
      />,
    );
    const scrollEl = container.querySelector<HTMLElement>(".code-view-scroll");
    if (!scrollEl) throw new Error("scroll container did not mount");

    // The REAL viewport moved (not just the virtual window state): the effect set the
    // element's scrollTop through its ref, so the row is actually on-screen rather than
    // hidden behind a spacer at scrollTop 0.
    await waitFor(() => {
      expect(scrollEl.scrollTop).toBeGreaterThan(150 * 18);
    });
    // ...and the window followed, so the focused row is painted and the top recycled.
    expect(Number(scrollEl.getAttribute("data-window-start"))).toBeGreaterThan(150);
    expect(container.querySelector('[data-raw-index="200"]')).not.toBeNull();
    expect(container.querySelector('[data-raw-index="0"]')).toBeNull();
  });

  it("moves once per nonce, never re-scrolls on an unchanged render, and re-points on a new nonce (#79)", async () => {
    const props = {
      path: "src/big.ts",
      diff: bigDiff(400),
      hunkOccurrences: [[{ id: "H", oldStart: 1, oldLines: 400, newStart: 1, newLines: 400 }]],
      rowHeight: 18,
      viewportHeight: 480,
      focusAnchor: "rennet:hunk/H#L200@additions",
    } as const;
    const { container, rerender } = mount(<CodeView {...props} focusNonce={1} />);
    const scrollEl = container.querySelector<HTMLElement>(".code-view-scroll");
    if (!scrollEl) throw new Error("scroll container did not mount");
    await waitFor(() => expect(scrollEl.scrollTop).toBeGreaterThan(150 * 18));
    const firstPulse = container.querySelector<HTMLElement>(".cv-focus");
    if (!firstPulse) throw new Error("focused row did not mount");

    rerender(<CodeView {...props} focusNonce={1} />);
    await Promise.resolve();
    expect(container.querySelector(".cv-focus")).toBe(firstPulse);

    rerender(<CodeView {...props} focusNonce={2} />);
    await waitFor(() => expect(scrollEl.scrollTop).toBeGreaterThan(150 * 18));
    const secondPulse = container.querySelector<HTMLElement>(".cv-focus");
    expect(secondPulse?.getAttribute("data-focus-nonce")).toBe("2");
    expect(secondPulse).not.toBe(firstPulse);

    fireEvent.scroll(scrollEl, { target: { scrollTop: 900 } });
    expect(scrollEl.scrollTop).toBe(900);
    rerender(<CodeView {...props} focusNonce={2} />);
    await Promise.resolve();
    expect(scrollEl.scrollTop).toBe(900);
  });

  it("malformed and orphan focus anchors are honest no-ops", async () => {
    const base = {
      path: "src/big.ts",
      diff: bigDiff(400),
      hunkOccurrences: [[{ id: "H", oldStart: 1, oldLines: 400, newStart: 1, newLines: 400 }]],
      rowHeight: 18,
      viewportHeight: 480,
    } as const;
    const { container, rerender } = mount(
      <CodeView {...base} focusAnchor="not-an-anchor" focusNonce={1} />,
    );
    const scrollEl = container.querySelector<HTMLElement>(".code-view-scroll");
    if (!scrollEl) throw new Error("scroll container did not mount");
    expect(scrollEl.scrollTop).toBe(0);
    expect(container.querySelector(".cv-focus")).toBeNull();
    rerender(<CodeView {...base} focusAnchor="rennet:hunk/NOPE#L1@additions" focusNonce={2} />);
    await Promise.resolve();
    expect(scrollEl.scrollTop).toBe(0);
    expect(container.querySelector(".cv-focus")).toBeNull();
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
        hunkOccurrences={OCC_H}
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
