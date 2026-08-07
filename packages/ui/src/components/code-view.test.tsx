import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { demoDiff } from "../canvas/fixtures";
import { MAX_RENDERED_NODES } from "../canvas/logic";
import { CodeView } from "./code-view";

function nodeCount(html: string): number {
  return (html.match(/<[a-zA-Z]/g) ?? []).length;
}

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

  it("windows follow the scroll position: a mid-file seed renders mid-file rows, not row 1", () => {
    const diff = demoDiff(5000);
    const top = renderToStaticMarkup(
      <CodeView path="x.ts" diff={diff} rowHeight={18} viewportHeight={480} scrollTop={0} />,
    );
    const mid = renderToStaticMarkup(
      <CodeView path="x.ts" diff={diff} rowHeight={18} viewportHeight={480} scrollTop={36000} />,
    );
    // The top of the file shows line 1; a mid-file scroll seed shows ~line 1993
    // and NOT line 1 — proving the window is a live function of scroll position
    // (a regression that froze the window to row 0 would fail this).
    expect(top).toContain('class="code-view-ln">1</span>');
    expect(mid).not.toContain('class="code-view-ln">1</span>');
    expect(mid).toMatch(/class="code-view-ln">199\d<\/span>/);
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
