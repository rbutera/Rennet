import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { demoDiff } from "../canvas/fixtures";
import { MAX_RENDERED_NODES } from "../canvas/logic";
import type { Mark } from "../canvas/registrar";
import { CodeView } from "./code-view";

function nodeCount(html: string): number {
  return (html.match(/<[a-zA-Z]/g) ?? []).length;
}

// A single-hunk diff with a real @@ header, so file lines and spans are meaningful.
//  raw  text                     side  fileLine sideOrd
//   0   @@ -10,3 +10,4 @@         header  -        -
//   1      const a = 1;          ctx     10       1
//   2   -  const b = 2;          del     11       1
//   3   +  const b = 3;          add     11       1
//   4   +  const c = 4;          add     12       2
//   5      return a;             ctx     13       2
const ONE_HUNK = [
  "@@ -10,3 +10,4 @@",
  "   const a = 1;",
  "-  const b = 2;",
  "+  const b = 3;",
  "+  const c = 4;",
  "   return a;",
].join("\n");

describe("CodeView — windowed diff holds the Pierre node-count envelope", () => {
  it("renders a 5000-line diff within the envelope, while a full render exceeds it", () => {
    const diff = demoDiff(5000);
    const windowed = renderToStaticMarkup(
      <CodeView
        path="src/big.ts"
        diff={diff}
        rowHeight={18}
        viewportHeight={480}
        scrollTop={40000}
      />,
    );
    const full = renderToStaticMarkup(<CodeView path="src/big.ts" diff={diff} renderAll />);

    expect(nodeCount(windowed)).toBeLessThanOrEqual(MAX_RENDERED_NODES);
    // Control: the naive full render of the same fixture blows the envelope — the
    // test can go red if windowing regresses.
    expect(nodeCount(full)).toBeGreaterThan(MAX_RENDERED_NODES);
    expect(windowed).toContain('data-total-rows="5000"');
  });

  it("windows follow the scroll position: a mid-file seed renders a mid-file window, not row 0", () => {
    const diff = demoDiff(5000);
    const top = renderToStaticMarkup(
      <CodeView path="x.ts" diff={diff} rowHeight={18} viewportHeight={480} scrollTop={0} />,
    );
    const mid = renderToStaticMarkup(
      <CodeView path="x.ts" diff={diff} rowHeight={18} viewportHeight={480} scrollTop={36000} />,
    );
    // The window is a live function of scroll: the top starts at row 0, the mid
    // seed does not — a regression that froze the window to row 0 fails this.
    expect(top).toContain('data-window-start="0"');
    expect(mid).not.toContain('data-window-start="0"');
    // And rows now carry REAL file lines, not diff-row indices: the top of the
    // file shows file line 1; the mid window is far past it.
    expect(top).toContain('data-file-line="1"');
    expect(mid).not.toContain('data-file-line="1"');
  });

  it("marks add/delete/context rows for the opaque code body", () => {
    const html = renderToStaticMarkup(
      <CodeView path="a.ts" diff={"+  added\n-  removed\n   kept"} viewportHeight={480} />,
    );
    expect(html).toContain("cv-add");
    expect(html).toContain("cv-del");
    expect(html).toContain("cv-ctx");
  });
});

describe("CodeView — rows carry real identity from the @@ headers", () => {
  it("assigns real file lines + side + occurrence per row, side-aware", () => {
    const html = renderToStaticMarkup(
      <CodeView path="foo.ts" diff={ONE_HUNK} occurrenceIds="H" viewportHeight={480} />,
    );
    // Context row shows the new-file line 10; the deletion shows old-file line 11.
    expect(html).toContain('data-file-line="10"');
    expect(html).toContain('data-side="deletions" data-file-line="11"');
    expect(html).toContain('data-side="additions" data-file-line="11"');
    expect(html).toContain('data-side="additions" data-file-line="12"');
    // The occurrence identity is on the row, so an anchor can find it.
    expect(html).toContain('data-occurrence="H"');
  });
});

describe("CodeView — L3 marks render AT their anchors, never in a strip", () => {
  const card = (mark: Mark) => <b data-testcard={mark.markId}>{mark.body}</b>;

  it("glows exactly the anchored rows and puts the ◇ gutter glyph at the mark's home row", () => {
    const marks: Mark[] = [
      {
        markId: "ann1",
        markKind: "annotation",
        anchor: "rennet:hunk/H#L1-L2@additions",
        body: "new lines",
      },
    ];
    const html = renderToStaticMarkup(
      <CodeView
        path="foo.ts"
        diff={ONE_HUNK}
        occurrenceIds="H"
        marks={marks}
        viewportHeight={480}
      />,
    );
    // Both addition rows glow and carry the mark id (the highlight is AT the span).
    expect((html.match(/data-mark="ann1"/g) ?? []).length).toBe(2);
    expect(html).toContain("cv-glow");
    // The gutter glyph (the agent's hand) renders once, at the FIRST spanned row.
    expect((html.match(/data-gutter-marks="ann1"/g) ?? []).length).toBe(1);
    expect(html).toContain('data-l3="mark"');
    expect(html).toContain("◇");
  });

  it("renders a proposal card inline at its span, via the host card renderer", () => {
    const marks: Mark[] = [
      {
        markId: "prop1",
        markKind: "proposal",
        anchor: "rennet:hunk/H#L1@deletions",
        body: "request change",
      },
    ];
    const html = renderToStaticMarkup(
      <CodeView
        path="foo.ts"
        diff={ONE_HUNK}
        occurrenceIds="H"
        marks={marks}
        renderMarkCard={card}
        viewportHeight={480}
      />,
    );
    // The card renders inline at the deletion row it targets — not in a strip.
    expect(html).toContain('data-mark-card="prop1"');
    expect(html).toContain('data-testcard="prop1"');
    expect(html).toContain("request change");
  });

  it("an unresolvable-anchor mark never renders inline — it is not silently glued anywhere", () => {
    const marks: Mark[] = [
      {
        markId: "orphan1",
        markKind: "annotation",
        anchor: "rennet:hunk/H#L9@additions",
        body: "gone",
      },
    ];
    const html = renderToStaticMarkup(
      <CodeView
        path="foo.ts"
        diff={ONE_HUNK}
        occurrenceIds="H"
        marks={marks}
        viewportHeight={480}
      />,
    );
    // The orphan gets NO glow, NO gutter glyph in the code — it must surface in the
    // host's orphan tray instead (verified at the registrar + workspace level).
    expect(html).not.toContain('data-mark="orphan1"');
    expect(html).not.toContain('data-gutter-marks="orphan1"');
  });

  it("recycle-safe: a mark windowed OUT does not glow anywhere; scrolled back IN it re-attaches to its own row", () => {
    // A long single hunk so the mark's row genuinely leaves the window (real
    // recycling, not the 6-row case where every row is always rendered). The 150th
    // addition is raw index 150 (raw 0 is the @@ header), fileLine 150.
    const bigDiff = [
      "@@ -1,1 +1,200 @@",
      ...Array.from({ length: 200 }, (_unused, i) => `+  line ${i + 1}`),
    ].join("\n");
    const marks: Mark[] = [
      {
        markId: "ann1",
        markKind: "annotation",
        anchor: "rennet:hunk/H#L150@additions",
        body: "deep mark",
      },
    ];
    const props = { path: "big.ts", diff: bigDiff, occurrenceIds: "H", marks, viewportHeight: 480 };

    // Scrolled to the top: raw 150 is far below the window, so it is NOT rendered —
    // and crucially the mark glows on NO other (visible) row.
    const atTop = renderToStaticMarkup(<CodeView {...props} scrollTop={0} />);
    expect(atTop).toContain('data-raw-index="1"'); // the window is real (top rows painted)
    expect(atTop).not.toContain('data-raw-index="150"'); // the mark's row is windowed out
    expect(atTop).not.toContain('data-mark="ann1"'); // no phantom glow on a visible row
    expect(atTop).not.toContain('data-gutter-marks="ann1"');

    // Scrolled down so raw 150 enters the window: the mark re-attaches to THAT SAME
    // row (data-mark on the same element as data-raw-index="150"), keyed by rawIndex,
    // never by window position — the recycle-safety guarantee, at the render level.
    const atMark = renderToStaticMarkup(<CodeView {...props} scrollTop={150 * 18} />);
    expect(atMark).toMatch(/data-raw-index="150"[^>]*data-file-line="150"[^>]*data-mark="ann1"/);
    expect(atMark).toContain('data-gutter-marks="ann1"');
    expect(atMark).not.toContain('data-raw-index="1"'); // and the top has recycled away
  });

  it("focusAnchor pulses the pointed-at span (agent-points deixis)", () => {
    const html = renderToStaticMarkup(
      <CodeView
        path="foo.ts"
        diff={ONE_HUNK}
        occurrenceIds="H"
        focusAnchor="rennet:hunk/H#L1@deletions"
        viewportHeight={480}
      />,
    );
    expect(html).toContain("cv-focus");
  });
});
