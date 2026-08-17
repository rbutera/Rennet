import type { RenderedHunkOccurrence } from "@rennet/types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { demoDiff } from "../canvas/fixtures";
import { MAX_RENDERED_NODES } from "../canvas/logic";
import type { Mark } from "../canvas/registrar";
import { CodeView } from "./code-view";

function nodeCount(html: string): number {
  return (html.match(/<[a-zA-Z]/g) ?? []).length;
}

// The single-occurrence mapping for ONE_HUNK (`@@ -10,3 +10,4 @@`): one rendered hunk
// = occurrence "H", with its REAL line range (rows are partitioned by containment, so
// the range must cover them).
const OCC_H: RenderedHunkOccurrence[][] = [
  [{ id: "H", oldStart: 10, oldLines: 3, newStart: 10, newLines: 4 }],
];

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
      <CodeView path="foo.ts" diff={ONE_HUNK} hunkOccurrences={OCC_H} viewportHeight={480} />,
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
        hunkOccurrences={OCC_H}
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
        hunkOccurrences={OCC_H}
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
        hunkOccurrences={OCC_H}
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
    // The occurrence "H" spans the whole 200-addition hunk (new lines 1..200).
    const occBig: RenderedHunkOccurrence[][] = [
      [{ id: "H", oldStart: 1, oldLines: 1, newStart: 1, newLines: 200 }],
    ];
    const marks: Mark[] = [
      {
        markId: "ann1",
        markKind: "annotation",
        anchor: "rennet:hunk/H#L150@additions",
        body: "deep mark",
      },
    ];
    const props = {
      path: "big.ts",
      diff: bigDiff,
      hunkOccurrences: occBig,
      marks,
      viewportHeight: 480,
    };

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
        hunkOccurrences={OCC_H}
        focusAnchor="rennet:hunk/H#L1@deletions"
        viewportHeight={480}
      />,
    );
    expect(html).toContain("cv-focus");
  });
});

describe("CodeView — syntax highlighting rides UNDER the diff colouring (issue #68)", () => {
  it("tokenizes column-zero shell diff comments after removing the +/- marker", () => {
    const html = renderToStaticMarkup(
      <CodeView
        path="script.sh"
        diff={["+# added", "-# removed", "+echo foo#bar"].join("\n")}
        viewportHeight={480}
      />,
    );
    expect(html).toContain('rtok-comment"># added</span>');
    expect(html).toContain('rtok-comment"># removed</span>');
    expect(html.match(/rtok-comment/g) ?? []).toHaveLength(2);
    expect(html).toContain("foo#bar");
  });

  it("wraps code in token spans for a known language, on both context and diff rows", () => {
    const html = renderToStaticMarkup(
      <CodeView path="src/x.ts" diff={ONE_HUNK} hunkOccurrences={OCC_H} viewportHeight={480} />,
    );
    // A keyword on the context row and on the changed rows is highlighted.
    expect(html).toContain('rtok-keyword">const</span>');
    // Numbers, too, so the diff is genuinely tokenized (not just the leading marker).
    expect(html).toContain('rtok-number">3</span>');
  });

  it("a highlighted token on an added line STILL reads as added (diff colour dominant)", () => {
    const diff = ["@@ -1,1 +1,2 @@", "   const a = 1;", "+  return a;"].join("\n");
    const html = renderToStaticMarkup(
      <CodeView path="src/x.ts" diff={diff} hunkOccurrences={OCC_H} viewportHeight={480} />,
    );
    // The add row carries BOTH the diff class (dominant, full-row) AND the syntax
    // highlight for `return` — the highlight composes under the diff semantic. The
    // match is scoped to a SINGLE row (no intervening code-view-row opens between the
    // cv-add class and the keyword span), so it cannot pass via a keyword on a
    // different row.
    expect(html).toMatch(
      /class="code-view-row cv-add"(?:(?!code-view-row)[\s\S])*?rtok-keyword">return<\/span>/,
    );
  });

  it("fails closed for an unknown extension: plain text, no fabricated colouring", () => {
    const html = renderToStaticMarkup(
      <CodeView path="Makefile" diff={ONE_HUNK} hunkOccurrences={OCC_H} viewportHeight={480} />,
    );
    // No semantic token classes, and the code text stays contiguous (never split
    // into keyword/number spans) — proof the tokenizer did not run.
    expect(html).not.toContain("rtok-keyword");
    expect(html).toContain("const a = 1;");
  });

  it("never tokenizes the @@ hunk header — it stays muted chrome, uncoloured", () => {
    const html = renderToStaticMarkup(
      <CodeView path="src/x.ts" diff={ONE_HUNK} hunkOccurrences={OCC_H} viewportHeight={480} />,
    );
    // The header text is emitted whole INSIDE its <code> element, with NO token
    // spans — if it were tokenized, the raw string would be shredded across
    // rtok spans and this contiguous-inside-<code> assertion would fail.
    expect(html).toContain('<code class="code-view-code">@@ -10,3 +10,4 @@</code>');
  });

  it("keeps the R16 node envelope WITH highlighting on (5000-line windowed render)", () => {
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
    // Highlighting is genuinely active on this render (token spans present)…
    expect(windowed).toContain("rtok-keyword");
    // …and the windowed node count is still inside the Pierre envelope — the added
    // token spans did not break windowing. Tokenizing off-screen rows creates no DOM
    // nodes; a regression that RENDERED the whole file (not just the window) would
    // blow this.
    expect(nodeCount(windowed)).toBeLessThanOrEqual(MAX_RENDERED_NODES);
  });

  it("token-dense rows degrade to plain so highlighting cannot blow the R16 node envelope", () => {
    // Per-token spans are DOM nodes. A demoDiff row is a handful of tokens, so the
    // envelope test above has huge headroom — it does NOT exercise the case where a
    // few pathologically dense rows (minified-ish, alternating single-char tokens)
    // shatter into hundreds of spans each. Uncapped, three ~1900-char rows produce
    // ~6000 nodes and blow MAX_RENDERED_NODES; the per-line token cap degrades each
    // to a single plain token instead. Red-able: remove the cap and both the node
    // count AND the "no rtok on the dense rows" assertion fail.
    const denseLine = `+ ${"a+".repeat(950)}`; // ~1900 chars, ~1900 tokens if uncapped
    const diff = [denseLine, denseLine, denseLine].join("\n");
    const html = renderToStaticMarkup(
      <CodeView path="src/x.ts" diff={diff} viewportHeight={480} />,
    );
    // All three dense rows are in the (tiny) window and painted…
    expect((html.match(/class="code-view-row/g) ?? []).length).toBe(3);
    // …each collapsed to exactly ONE plain token span (not hundreds): three rows →
    // three token spans total. Uncapped, this render emits ~5700 spans. That is the
    // degradation the cap guarantees, and it is what keeps the node budget bounded.
    expect((html.match(/class="rtok /g) ?? []).length).toBe(3);
    expect(html).not.toContain("rtok-operator"); // no per-token hues on the degraded rows
    expect(nodeCount(html)).toBeLessThanOrEqual(MAX_RENDERED_NODES);
  });
});
