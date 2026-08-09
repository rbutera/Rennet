import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { demoCanvases } from "../canvas/fixtures";
import { createViewStore } from "../canvas/store";
import { CanvasWorkspace } from "./workspace";

// ─────────────────────────────────────────────────────────────────────────────
// Issue #63 — the CODE is the reading surface. A reviewer must be able to read
// the actual hunk, not just metadata cards about it. These tests pin the product
// promise: selecting an element (the natural "let me read this" gesture) reveals
// the real diff inline, and it does so at element zoom — not only at the deepest
// diff zoom the reviewer rarely reaches.
// ─────────────────────────────────────────────────────────────────────────────

const DIFF = [
  "@@ -1,4 +1,4 @@ export function renderReview()",
  "   const review = loadReview();",
  "-  return renderMetadataCards(review);",
  "+  return renderCodeView(review);",
  "   // the code is the material",
].join("\n");

function diffFor() {
  return { path: "packages/ui/src/review.ts", diff: DIFF };
}

describe("CanvasWorkspace — code is visible in the review flow (#63)", () => {
  it("reveals the real diff when an element is SELECTED (element zoom), not only at diff zoom", () => {
    const store = createViewStore({
      angle: "decisions",
      selection: "dec-1-1",
      zoom: { level: "element", elementKey: "dec-1-1" },
    });
    const html = renderToStaticMarkup(
      <CanvasWorkspace canvases={demoCanvases()} store={store} diffFor={diffFor} />,
    );
    // The code surface is mounted with the real path...
    expect(html).toContain("code-view");
    expect(html).toContain("packages/ui/src/review.ts");
    // ...and the actual hunk content is readable, added and removed lines both.
    expect(html).toContain("renderCodeView");
    expect(html).toContain("renderMetadataCards");
  });

  it("still shows the code at the deepest diff zoom", () => {
    const store = createViewStore({
      angle: "decisions",
      selection: "dec-1-1",
      zoom: { level: "diff", elementKey: "dec-1-1" },
    });
    const html = renderToStaticMarkup(
      <CanvasWorkspace canvases={demoCanvases()} store={store} diffFor={diffFor} />,
    );
    expect(html).toContain("code-view");
    expect(html).toContain("renderCodeView");
  });

  it("shows no code at the roll-up altitude (nothing selected to read yet)", () => {
    const store = createViewStore({ angle: "decisions", zoom: { level: "rollup" } });
    const html = renderToStaticMarkup(
      <CanvasWorkspace canvases={demoCanvases()} store={store} diffFor={diffFor} />,
    );
    expect(html).not.toContain("code-view-scroll");
  });
});
