// @vitest-environment happy-dom
//
// The in-diff discuss affordances (issue #36): mounted-DOM proof that the CodeView
// speaks the "verbs times anchors" abstraction — one `onDiscuss` callback emitting a
// LINE anchor (plain click), a RANGE anchor (shift-click), and a CHUNK anchor (the
// header verb). These assertions are impossible under the SSR harness: they drive
// real click events with modifier keys and assert the emitted anchor.
import type { RenderedHunkOccurrence } from "@rennet/types";
import { describe, expect, it } from "vitest";
import type { ConversationAnchor } from "../canvas/conversation";
import { fireEvent, mount } from "../test/dom";
import { CodeView } from "./code-view";

// A hunk with real file lines so a row's discuss glyph anchors to a concrete line.
const HUNK = [
  "@@ -10,3 +10,4 @@",
  "   const a = 1;",
  "-  const b = 2;",
  "+  const b = 3;",
  "+  const c = 4;",
  "   return a;",
].join("\n");
const OCC: RenderedHunkOccurrence[][] = [
  [{ id: "H", oldStart: 10, oldLines: 3, newStart: 10, newLines: 4 }],
];

type SpanSelection = { anchor: string; excerpt: string };

function mountView(
  onDiscuss?: (anchor: ConversationAnchor) => void,
  onSpanSelect?: (selection: SpanSelection | null) => void,
) {
  return mount(
    <CodeView
      path="src/rate/bucket.ts"
      diff={HUNK}
      hunkOccurrences={OCC}
      rowHeight={18}
      viewportHeight={480}
      renderAll
      onDiscuss={onDiscuss}
      onSpanSelect={onSpanSelect}
      onDispose={() => undefined}
    />,
  );
}

function discussGlyphs(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("[data-cv-discuss]"));
}

describe("CodeView — the in-diff discuss affordances (issue #36)", () => {
  it("plain-click reports the exact occurrence-relative single-line span and excerpt (#79)", () => {
    const selected: (SpanSelection | null)[] = [];
    const { container } = mountView(
      () => undefined,
      (selection) => selected.push(selection),
    );
    const addition = discussGlyphs(container).find(
      (glyph) => glyph.getAttribute("data-cv-discuss-side") === "additions",
    );
    if (!addition) throw new Error("need an addition glyph");
    fireEvent.click(addition);
    expect(selected).toEqual([
      {
        anchor: "rennet:hunk/H#L1@additions",
        excerpt: "  const b = 3;",
      },
    ]);
  });

  it("same-side shift-click reports the exact occurrence-relative range and excerpt (#79)", () => {
    const selected: (SpanSelection | null)[] = [];
    const { container } = mountView(
      () => undefined,
      (selection) => selected.push(selection),
    );
    const additions = discussGlyphs(container).filter(
      (glyph) => glyph.getAttribute("data-cv-discuss-side") === "additions",
    );
    const first = additions[0];
    const second = additions[1];
    if (!first || !second) throw new Error("need two addition glyphs");
    fireEvent.click(first);
    fireEvent.click(second, { shiftKey: true });
    expect(selected.at(-1)).toEqual({
      anchor: "rennet:hunk/H#L1-L2@additions",
      excerpt: "  const b = 3;\n  const c = 4;",
    });
  });

  it("renders a per-line discuss glyph only on content rows with a real file line", () => {
    const { container } = mountView(() => undefined);
    const glyphs = discussGlyphs(container);
    // Every content row (a/b context, the deletion, the two additions, return) gets a
    // glyph; the `@@` header row does not (nothing to anchor to).
    expect(glyphs.length).toBeGreaterThanOrEqual(4);
    for (const glyph of glyphs) {
      expect(glyph.getAttribute("data-cv-discuss")).toMatch(/^\d+$/);
    }
  });

  it("does NOT render discuss glyphs when onDiscuss is absent (additive, no regression)", () => {
    const { container } = mountView(undefined);
    expect(discussGlyphs(container)).toHaveLength(0);
    // …and the header discuss verb is likewise absent.
    expect(container.querySelector(".code-view-head .discuss-control")).toBeNull();
  });

  it("plain-clicking a line's glyph emits a side-keyed LINE anchor carrying the side (F1)", () => {
    const seen: ConversationAnchor[] = [];
    const { container } = mountView((anchor) => seen.push(anchor));
    const glyph = discussGlyphs(container)[0];
    if (!glyph) throw new Error("no discuss glyph");
    const line = Number(glyph.getAttribute("data-cv-discuss"));
    const side = glyph.getAttribute("data-cv-discuss-side");
    const context = glyph
      .closest(".code-view-row")
      ?.querySelector(".code-view-code")
      ?.textContent?.replace(/^[ +-]/, "");
    fireEvent.click(glyph);
    expect(seen).toHaveLength(1);
    // The key is kind-prefixed and injective; `side` rides as SEMANTIC data (F1), so
    // `buildConversationQuestion` can tell the model which side the reviewer pointed at.
    expect(seen[0]).toEqual({
      kind: "line",
      label: `src/rate/bucket.ts:${line}`,
      key: `line|src/rate/bucket.ts|${side}|${line}`,
      side,
      path: "src/rate/bucket.ts",
      context,
    });
  });

  it("keys the two diff SIDES injectively: old-deletion and new-addition never collide (#36 HIGH-2)", () => {
    const seen: ConversationAnchor[] = [];
    const { container } = mountView((anchor) => seen.push(anchor));
    const glyphs = discussGlyphs(container);
    const del = glyphs.find((g) => g.getAttribute("data-cv-discuss-side") === "deletions");
    const add = glyphs.find((g) => g.getAttribute("data-cv-discuss-side") === "additions");
    if (!del || !add) throw new Error("need a deletion and an addition row");
    fireEvent.click(del);
    fireEvent.click(add);
    const delAnchor = seen[0];
    const addAnchor = seen[1];
    // Distinct keys AND distinct carried sides — even if the two sit at the same line number.
    expect(delAnchor?.key).not.toBe(addAnchor?.key);
    expect(delAnchor?.side).toBe("deletions");
    expect(addAnchor?.side).toBe("additions");
    expect(delAnchor?.key.startsWith("line|src/rate/bucket.ts|deletions|")).toBe(true);
    expect(addAnchor?.key.startsWith("line|src/rate/bucket.ts|additions|")).toBe(true);
  });

  it("shift-clicking a second SAME-SIDE glyph emits a RANGE anchor spanning the two lines", () => {
    const seen: ConversationAnchor[] = [];
    const { container } = mountView((anchor) => seen.push(anchor));
    // Two glyphs on the SAME side (both additions) with distinct lines — a range never
    // spans pre- and post-image.
    const adds = discussGlyphs(container).filter(
      (g) => g.getAttribute("data-cv-discuss-side") === "additions",
    );
    const first = adds[0];
    const last = adds[adds.length - 1];
    if (!first || !last || first === last) throw new Error("need two addition glyphs");
    const a = Number(first.getAttribute("data-cv-discuss"));
    const b = Number(last.getAttribute("data-cv-discuss"));
    expect(a).not.toBe(b);
    fireEvent.click(first); // plain click records the range start (+ opens a line thread)
    fireEvent.click(last, { shiftKey: true }); // same-side shift-click completes the range
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    expect(seen.at(-1)).toEqual({
      kind: "range",
      label: `src/rate/bucket.ts:${lo}-${hi}`,
      key: `range|src/rate/bucket.ts|additions|${lo}|${hi}`,
      side: "additions",
      path: "src/rate/bucket.ts",
      context: "  const b = 3;\n  const c = 4;",
    });
  });

  it("a CROSS-side shift-click at DIFFERENT lines does not form a range — the side guard, not luck", () => {
    // ⚠️ The endpoints must be on different LINE NUMBERS, else the line-equality guard
    // hides whether the SIDE guard fired. Pick a deletion and an addition whose file
    // lines differ, so only `rangeStart.side === side` prevents the cross-image range.
    const seen: ConversationAnchor[] = [];
    const { container } = mountView((anchor) => seen.push(anchor));
    const glyphs = discussGlyphs(container);
    const del = glyphs.find((g) => g.getAttribute("data-cv-discuss-side") === "deletions");
    const adds = glyphs.filter((g) => g.getAttribute("data-cv-discuss-side") === "additions");
    if (!del) throw new Error("need a deletion row");
    const delLine = Number(del.getAttribute("data-cv-discuss"));
    // An addition on a DIFFERENT line number than the deletion.
    const add = adds.find((g) => Number(g.getAttribute("data-cv-discuss")) !== delLine);
    if (!add) throw new Error("need an addition on a different line than the deletion");
    expect(Number(add.getAttribute("data-cv-discuss"))).not.toBe(delLine);
    fireEvent.click(del); // records a deletion-side start
    fireEvent.click(add, { shiftKey: true }); // different side → NOT a range (only the side guard stops it)
    // The last anchor is a fresh LINE on the addition side, never a cross-image range.
    expect(seen.at(-1)?.kind).toBe("line");
    expect(seen.at(-1)?.side).toBe("additions");
  });

  it("the chunk-header discuss verb emits a CHUNK anchor keyed by the path", () => {
    const seen: ConversationAnchor[] = [];
    const { container } = mountView((anchor) => seen.push(anchor));
    const headerDiscuss = container.querySelector<HTMLButtonElement>(
      ".code-view-head .discuss-control",
    );
    if (!headerDiscuss) throw new Error("no header discuss control");
    fireEvent.click(headerDiscuss);
    expect(seen.at(-1)).toEqual({
      kind: "chunk",
      label: "src/rate/bucket.ts",
      key: "chunk|src/rate/bucket.ts",
    });
  });

  it("the glyph is absolutely positioned so it consumes no grid track (no reflow)", () => {
    // The row grid stays two tracks (line-number, code); the glyph rides absolutely.
    // A glyph rendered as a grid child would push the code column — the exact reflow
    // the issue forbids. Asserting the class contract is the red-provable proxy for it
    // in happy-dom (which does no layout): the button carries `cv-discuss`, whose CSS
    // is `position:absolute`, and the row still holds exactly the ln + code cells.
    const { container } = mountView(() => undefined);
    const row = container.querySelector<HTMLElement>(".code-view-row.cv-ctx");
    if (!row) throw new Error("no content row");
    expect(row.querySelector(".cv-discuss")).not.toBeNull();
    expect(row.querySelector(".code-view-ln")).not.toBeNull();
    expect(row.querySelector(".code-view-code")).not.toBeNull();
  });
});
